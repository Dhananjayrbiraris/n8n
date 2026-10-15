import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { isTracingSuppressed } from '@opentelemetry/core';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {
	runWithTracingRestored,
	runWithTracingSuppressed,
	suppressTracingOnMethods,
} from 'src/utils/tracing-suppression';

const isSuppressed = () => isTracingSuppressed(context.active());

class BaseService {
	label = 'base';

	inherited() {
		return { suppressed: isSuppressed(), self: this };
	}
}

class Service extends BaseService {
	getterCalls = 0;

	get counted() {
		this.getterCalls++;
		return 'value';
	}

	syncValue(a: number, b: number) {
		return { sum: a + b, suppressed: isSuppressed(), self: this };
	}

	async asyncValue() {
		await new Promise((resolve) => setImmediate(resolve));
		return { suppressed: isSuppressed(), self: this };
	}

	fail(error: Error): never {
		throw error;
	}

	async failAsync(error: Error): Promise<never> {
		throw error;
	}
}

describe('tracing suppression', () => {
	const contextManager = new AsyncLocalStorageContextManager();

	beforeAll(() => {
		context.setGlobalContextManager(contextManager.enable());
	});

	afterAll(() => {
		contextManager.disable();
		context.disable();
	});

	describe('runWithTracingSuppressed', () => {
		it('suppresses tracing inside the callback and across awaits, not in the caller', async () => {
			const seen: boolean[] = [];

			await runWithTracingSuppressed(async () => {
				seen.push(isSuppressed());
				await new Promise((resolve) => setImmediate(resolve));
				seen.push(isSuppressed());
			});

			expect(seen).toEqual([true, true]);
			expect(isSuppressed()).toBe(false);
		});

		it('drops spans started inside, and keeps spans started in a restored scope', () => {
			const exporter = new InMemorySpanExporter();
			const tracer = new BasicTracerProvider({
				spanProcessors: [new SimpleSpanProcessor(exporter)],
			}).getTracer('test');

			runWithTracingSuppressed(() => {
				tracer.startSpan('suppressed').end();
				runWithTracingRestored(() => tracer.startSpan('restored').end());
			});

			expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['restored']);
		});
	});

	describe('suppressTracingOnMethods', () => {
		it('returns the same object', () => {
			const service = new Service();

			expect(suppressTracingOnMethods(service)).toBe(service);
		});

		it('runs own and inherited methods suppressed with the instance as `this`', async () => {
			const service = suppressTracingOnMethods(new Service());

			expect(service.inherited()).toEqual({ suppressed: true, self: service });
			expect(service.syncValue(1, 2)).toEqual({ sum: 3, suppressed: true, self: service });
			await expect(service.asyncValue()).resolves.toEqual({ suppressed: true, self: service });
			expect(isSuppressed()).toBe(false);
		});

		it('wraps function-valued own properties', () => {
			const instance = { run: () => isSuppressed() };

			expect(suppressTracingOnMethods(instance).run()).toBe(true);
		});

		it('keeps sync results sync and returns the same promise', () => {
			const promise = Promise.resolve('done');
			const service = suppressTracingOnMethods(
				Object.assign(new Service(), { pending: vi.fn().mockReturnValue(promise) }),
			);

			expect(service.syncValue(2, 3).sum).toBe(5);
			expect(service.pending()).toBe(promise);
		});

		it('passes errors through unchanged', async () => {
			const service = suppressTracingOnMethods(new Service());
			const error = new Error('boom');

			expect(() => service.fail(error)).toThrow(error);
			await expect(service.failAsync(error)).rejects.toBe(error);
		});

		it('does not call getters or add properties', async () => {
			const service = suppressTracingOnMethods(new Service());

			expect(service.getterCalls).toBe(0);
			expect('then' in service).toBe(false);
			await expect(Promise.resolve(service)).resolves.toBe(service);
		});

		it('runs prototype spies added after wrapping', () => {
			const service = suppressTracingOnMethods(new Service());
			const spy = vi.spyOn(Service.prototype, 'syncValue').mockImplementation(() => ({
				sum: 42,
				suppressed: isSuppressed(),
				self: service,
			}));

			expect(service.syncValue(1, 1)).toEqual({ sum: 42, suppressed: true, self: service });
			expect(spy).toHaveBeenCalledWith(1, 1);

			spy.mockRestore();
		});
	});
});
