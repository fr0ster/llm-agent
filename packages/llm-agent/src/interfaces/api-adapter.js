export class AdapterValidationError extends Error {
  statusCode;
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'AdapterValidationError';
  }
}
//# sourceMappingURL=api-adapter.js.map
