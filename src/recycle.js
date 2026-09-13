export const DAY = 86400000;
export const RECYCLE_DAYS = 30;
export const millis = value => value?.toMillis?.() ?? value;
export const restoreDeadline = record => record.restoreUntil ?? (millis(record.deletedAt) + RECYCLE_DAYS * DAY);
export const restorable = (record, now) => Boolean(record.deletedAt && now < restoreDeadline(record));
