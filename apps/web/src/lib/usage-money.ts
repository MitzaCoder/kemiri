const cents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wholeDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/**
 * USD for the Value tab and task usage, the same way everywhere: whole dollars from $100 up ("$1,640"), two decimals
 * below ("$42.50", "$35.00"), and "< $0.01" for a positive amount that would show as zero.
 */
export function usageMoney(amount: number): string {
	if (amount > 0 && amount < 0.005) return '< $0.01';
	return Math.abs(amount) >= 99.995 ? wholeDollars.format(amount) : cents.format(amount);
}
