/**
 * Type definitions and error classes for database migrations
 *
 * @module migrations/types
 */

/**
 * Error class for database migration failures
 */
export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly tableName?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}
