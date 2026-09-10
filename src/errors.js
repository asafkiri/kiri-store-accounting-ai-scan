export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}
export const fail = (status, code, message, details) => {
  throw new AppError(status, code, message, details);
};
