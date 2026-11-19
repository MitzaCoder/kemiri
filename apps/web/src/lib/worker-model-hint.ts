import type { ModelInfo, ThinkingLevel, WorkerModel } from '@kemiri/protocol';
import { sameModel } from './models.ts';
import { isWorkerOnly } from './official-agents.ts';

/** Project preference order, not a promise: a coordinator's explicit model still wins. */
export function projectWorkerModelRows(
	projectModels: readonly WorkerModel[],
	catalog: readonly ModelInfo[],
	thinkingOverride: ThinkingLevel | null
) {
	let foundDefault = false;
	return projectModels.map((ref, index) => {
		const model = catalog.find((entry) => sameModel(entry, ref));
		const role = model === undefined ? 'Unavailable' : foundDefault ? 'Fallback' : 'Default';
		if (model !== undefined) foundDefault = true;
		return {
			key: `${ref.provider}/${ref.modelId}`,
			name: model?.name ?? ref.modelId,
			provider: ref.provider,
			order: index + 1,
			role,
			officialAgent: model !== undefined && isWorkerOnly(model),
			thinking: thinkingOverride ?? ref.thinkingLevel ?? null
		};
	});
}
