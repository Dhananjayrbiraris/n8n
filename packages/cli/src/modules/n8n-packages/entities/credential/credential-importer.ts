import { Service } from '@n8n/di';
import { generateNanoId } from '@n8n/utils/generate-nano-id';
import { UnexpectedError } from 'n8n-workflow';

import { CredentialsService } from '@/credentials/credentials.service';

import { CredentialMatcherFactory } from './credential-matcher-factory';
import { credentialBlockingFailures, credentialsToStub } from './credential-missing-mode';
import type {
	CredentialApplyResult,
	CredentialBindingRequest,
	CredentialImportPlan,
	CredentialResolution,
	CredentialResolutionFailure,
} from './credential.types';
import type { ImportBindingMap, ImportContext } from '../../n8n-packages.types';

@Service()
export class CredentialImporter {
	constructor(
		private readonly credentialMatcherFactory: CredentialMatcherFactory,
		private readonly credentialsService: CredentialsService,
	) {}

	/**
	 * Resolves which target-project credentials the package's references map to.
	 * Read-only: returns matched `successes` and unresolved `failures` without
	 * acting on the failures. Mirrors the workflow side's `plan`.
	 */
	async plan(
		context: ImportContext,
		request: CredentialBindingRequest,
	): Promise<CredentialImportPlan> {
		const resolution = await this.credentialMatcherFactory
			.getMatcher(request.matchingMode)
			.match(request.requirements, {
				projectId: context.projectId,
				user: context.user,
				credentialBindings: request.credentialBindings,
			});
		const stubIds = new Map(
			credentialsToStub(request.missingMode, resolution).map(({ sourceId }) => [
				sourceId,
				request.matchingMode === 'id-only' ? sourceId : generateNanoId(),
			]),
		);
		return { ...resolution, stubIds };
	}

	/**
	 * Classifies which unresolved references block the import under the chosen
	 * missing-mode policy. Pure — the pipeline gates or reports these uniformly
	 * alongside other blocking issues.
	 */
	blockingFailures(
		request: CredentialBindingRequest,
		resolution: CredentialResolution,
	): CredentialResolutionFailure[] {
		return credentialBlockingFailures(request.missingMode, resolution);
	}

	/**
	 * Creates stub credentials for unresolved `not_found` references under
	 * `create-stub`, then returns the full source→target binding map.
	 * {@link CredentialsService.createStubCredential} enforces `credential:create`
	 * on the target project, and the `credentialSave` policy again after the plan checked it.
	 */
	async apply(
		context: ImportContext,
		request: CredentialBindingRequest,
		resolution: CredentialImportPlan,
	): Promise<CredentialApplyResult> {
		const bindings: ImportBindingMap = new Map(resolution.successes);
		const matched = [...resolution.successes.keys()];
		const stubbed: string[] = [];

		for (const credential of credentialsToStub(request.missingMode, resolution)) {
			const { sourceId, type, name } = credential;
			const targetId = resolution.stubIds.get(sourceId);
			if (type === undefined || targetId === undefined) {
				throw new UnexpectedError(
					`Cannot create stub for credential "${sourceId}": incomplete credential plan`,
				);
			}

			const stubCredential = await this.credentialsService.createStubCredential(
				{
					id: targetId,
					name: name ?? sourceId,
					type,
					projectId: context.projectId,
				},
				context.user,
			);

			bindings.set(sourceId, stubCredential.id);
			stubbed.push(sourceId);
		}

		return { bindings, matched, stubbed };
	}
}
