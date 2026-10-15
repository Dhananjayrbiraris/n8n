import { trace } from '@opentelemetry/api';

import { OtelTestProvider } from '../../../runtime/__tests__/support/otel-test-provider';
import { createSandbox } from '../../../workspace/sandbox/create-workspace';
import type { SandboxConfig } from '../../../workspace/sandbox/types';

const sdkCalls: Array<{ method: string; recording: boolean }> = [];

function recordSdkCall<T>(method: string, result?: T) {
	return vi.fn(async () => {
		const span = trace.getTracer('daytona').startSpan(method);
		sdkCalls.push({ method, recording: span.isRecording() });
		span.end();
		return await Promise.resolve(result);
	});
}

function makeSdkSandbox() {
	return {
		id: 'remote-sandbox',
		cpu: 2,
		memory: 4,
		target: 'us',
		state: 'started',
		process: {
			executeCommand: recordSdkCall('process.executeCommand', { exitCode: 0, result: 'ok' }),
		},
		fs: { listFiles: recordSdkCall('fs.listFiles') },
		start: recordSdkCall('sandbox.start'),
		waitUntilStarted: recordSdkCall('sandbox.waitUntilStarted'),
		stop: recordSdkCall('sandbox.stop'),
		delete: recordSdkCall('sandbox.delete'),
		getWorkDir: recordSdkCall('sandbox.getWorkDir', '/home/daytona'),
	};
}

class Daytona {
	get = vi.fn(async () => await recordSdkCall('client.get', makeSdkSandbox())());

	create = vi.fn(async () => await recordSdkCall('client.create', makeSdkSandbox())());

	delete = recordSdkCall('client.delete');
}

class DaytonaError extends Error {}
class DaytonaNotFoundError extends DaytonaError {}
class DaytonaTimeoutError extends DaytonaError {}

vi.mock('../../../workspace/sandbox/lazy-daytona', () => ({
	loadDaytona: () => ({ Daytona, DaytonaError, DaytonaNotFoundError, DaytonaTimeoutError }),
}));

const argsByMethod: Record<string, unknown[]> = {
	executeCommand: ['echo', ['hi']],
	withFilesystem: [
		async (fs: { listFiles: (path: string) => Promise<unknown> }) => await fs.listFiles('/'),
	],
};

function methodNames(instance: object): string[] {
	const names = new Set<string>();
	for (
		let owner: object | null = instance;
		owner && owner !== Object.prototype;
		owner = Reflect.getPrototypeOf(owner)
	) {
		for (const name of Object.getOwnPropertyNames(owner)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(owner, name);
			if (name !== 'constructor' && typeof descriptor?.value === 'function') names.add(name);
		}
	}
	return [...names];
}

async function callEveryMethod(config: SandboxConfig) {
	const probe = await createSandbox(config);
	for (const name of methodNames(probe as object)) {
		const sandbox = (await createSandbox(config)) as unknown as Record<
			string,
			(...args: unknown[]) => unknown
		>;
		await sandbox.start();
		await Promise.resolve()
			.then(async () => await sandbox[name](...(argsByMethod[name] ?? [])))
			.catch(() => undefined);
	}
}

const isRecording = () => {
	const span = trace.getTracer('test').startSpan('caller');
	const recording = span.isRecording();
	span.end();
	return recording;
};

describe('createSandbox Daytona tracing', () => {
	let otel: OtelTestProvider;

	const baseConfig: SandboxConfig = {
		enabled: true,
		provider: 'daytona',
		daytonaApiUrl: 'https://api.daytona.io',
		daytonaApiKey: 'test-key',
		timeout: 1_000,
	};

	beforeEach(() => {
		otel = OtelTestProvider.create();
		sdkCalls.length = 0;
	});

	afterEach(async () => {
		await otel.shutdown();
	});

	it('runs every SDK call with tracing suppressed by default', async () => {
		await callEveryMethod(baseConfig);

		expect(sdkCalls.length).toBeGreaterThan(0);
		expect(sdkCalls.filter((call) => call.recording)).toEqual([]);
		expect(isRecording()).toBe(true);
	});

	it('leaves SDK calls traced when tracing is enabled', async () => {
		await callEveryMethod({ ...baseConfig, tracingEnabled: true });

		expect(sdkCalls.length).toBeGreaterThan(0);
		expect(sdkCalls.filter((call) => !call.recording)).toEqual([]);
	});
});
