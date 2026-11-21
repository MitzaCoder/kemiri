import { expect, test } from 'bun:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import fixtures from '../../protocol/test-vectors/code-review.json';
import { formatCodeReview, type CodeReview, type CodeReviewSource } from '../../../apps/web/src/lib/code/code-review.ts';
import { reviewSubmitOptions } from '../../../apps/web/src/lib/review.ts';
import { createSetup, TestClient } from './support.ts';

test('one code review submission creates one task feedback entry, including on retry', async () => {
	const setup = await createSetup();
	const client = await TestClient.open(setup.server);
	try {
		await client.hello();
		const project = await client.request({ type: 'projects.add', path: setup.projectDir });
		if (project.type !== 'projects.add') throw new Error('Could not create the synthetic project');
		const projectId = project.project.id;
		await client.request({ type: 'projects.configure', projectId, coordinatorModel: { provider: 'faux', modelId: 'faux-1' } });
		setup.faux.setResponses([fauxAssistantMessage('The bakery hours are ready.')]);
		const { runtime } = await setup.server.manager.open(projectId);
		const { id: taskId } = await runtime.board.saveTask({ task: { title: 'Review bakery hours', description: '', acceptance: null, status: 'todo', blockedBy: [], blockedReason: null, writeScopes: [] } }, 'harness');
		const vector = fixtures[0]!;
		const content = formatCodeReview(vector.source as CodeReviewSource, vector.review as CodeReview);
		const request = { type: 'conversation.submit' as const, projectId, content, ...reviewSubmitOptions(taskId, 'synthetic-thread', 'synthetic-review-once') };
		for (let i = 0; i < 2; i++) {
			const response = await client.request(request);
			if (response.type !== 'conversation.submit') throw new Error(JSON.stringify(response));
		}
		const timeline = await client.request({ type: 'board.task.timeline', projectId, taskId });
		if (timeline.type !== 'board.task.timeline') throw new Error('Could not read task notes');
		expect(timeline.feedback).toHaveLength(1);
		expect(timeline.feedback[0]?.text).toBe(vector.expected);
	} finally { client.close(); await setup.cleanup(); }
});
