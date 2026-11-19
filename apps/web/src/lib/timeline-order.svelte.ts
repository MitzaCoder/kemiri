import { loadTimelineOrder, saveTimelineOrder } from './task-timeline.js';
const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
/** One reading direction for every task in this browser. */
class TimelineOrderPreference {
	order = $state(loadTimelineOrder(storage));
	toggle(): void {
		this.set(this.order === 'newest' ? 'oldest' : 'newest');
	}
	reset(): void { this.set('newest'); }
	private set(order: typeof this.order): void {
		this.order = order;
		saveTimelineOrder(storage, this.order);
	}
}
export const timelineOrder = new TimelineOrderPreference();
