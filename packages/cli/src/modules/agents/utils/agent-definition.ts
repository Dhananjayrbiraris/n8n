import type { AgentJsonConfig, AgentTaskConfig } from '@n8n/api-types';

import type { AgentHistory } from '../entities/agent-history.entity';
import type { Agent } from '../entities/agent.entity';

/** Published chat settings stay in schema. Credential integrations stay on the agent. */
export interface AgentDefinition extends Pick<Agent, 'schema' | 'tools' | 'skills'> {
	tasks: ReadonlyMap<string, AgentTaskConfig>;
}

/** Complete authored content, before integrations are split from the configuration. */
export interface CompleteAgentDefinition extends Pick<Agent, 'name' | 'tools' | 'skills'> {
	config: AgentJsonConfig | null;
	tasks: ReadonlyMap<string, AgentTaskConfig>;
}

/** Omitted metadata stays unchanged on ordinary saves and version restoration. */
export interface AgentDefinitionMetadata {
	sourceAgentId?: string | null;
	/** Keyed by destination task ID. */
	sourceTaskIds?: ReadonlyMap<string, string>;
	availableInMCP?: boolean;
}

/** IDs reserved for new definitions, with their authorized destination projects. */
export interface PlannedAgentDestinations {
	agents?: ReadonlyMap<string, string>;
	workflows?: ReadonlyMap<string, string>;
}

/** Keep configuration and inline bodies from the same draft or version. */
export function getAgentDefinitionContent(
	source: Pick<AgentHistory, 'schema' | 'tools' | 'skills'>,
) {
	return { schema: source.schema, tools: source.tools ?? {}, skills: source.skills ?? {} };
}

export function getAgentTaskBody(task: AgentTaskConfig) {
	const { name, objective, cronExpression, timezone } = task;
	return { name, objective, cronExpression, timezone: timezone ?? null };
}
