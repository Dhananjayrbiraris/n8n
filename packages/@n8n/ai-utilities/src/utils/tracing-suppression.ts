import { context } from '@opentelemetry/api';
import { suppressTracing, unsuppressTracing } from '@opentelemetry/core';

export function runWithTracingSuppressed<T>(fn: () => T): T {
	return context.with(suppressTracing(context.active()), fn);
}

export function runWithTracingRestored<T>(fn: () => T): T {
	return context.with(unsuppressTracing(context.active()), fn);
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === 'function';
}

export function suppressTracingOnMethods<T extends object>(instance: T): T {
	const seen = new Set<string>();

	for (
		let owner: object | null = instance;
		owner && owner !== Object.prototype;
		owner = Reflect.getPrototypeOf(owner)
	) {
		for (const name of Object.getOwnPropertyNames(owner)) {
			if (name === 'constructor' || seen.has(name)) continue;
			seen.add(name);

			const descriptor = Reflect.getOwnPropertyDescriptor(owner, name);
			if (!descriptor || !isFunction(descriptor.value)) continue;

			const ownMethod = owner === instance ? descriptor.value : undefined;
			const resolveMethod = (): unknown =>
				ownMethod ?? Reflect.get(Reflect.getPrototypeOf(instance) ?? {}, name, instance);

			Reflect.defineProperty(instance, name, {
				...descriptor,
				value: (...args: unknown[]) =>
					runWithTracingSuppressed(() => {
						const method = resolveMethod();
						if (!isFunction(method)) throw new TypeError(`${name} is not a function`);
						return Reflect.apply(method, instance, args);
					}),
			});
		}
	}

	return instance;
}
