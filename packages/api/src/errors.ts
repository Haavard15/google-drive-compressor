export class JobCancelledError extends Error {
  constructor(message = 'Cancelled by user') {
    super(message);
    this.name = 'JobCancelledError';
  }
}
