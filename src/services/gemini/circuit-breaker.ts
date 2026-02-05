/**
 * Circuit Breaker Pattern for Gemini API
 * Based on gemini-flash-3-dev-guide.md:
 * - threshold: 5 failures
 * - recovery_ms: 60000 (60 seconds)
 */

export enum CircuitState {
  CLOSED = 'CLOSED', // Normal operation
  OPEN = 'OPEN', // Failing, reject requests
  HALF_OPEN = 'HALF_OPEN', // Testing recovery
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeMs: number;
  halfOpenSuccessThreshold: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5, // From guide
  recoveryTimeMs: 60000, // From guide: 60 seconds
  halfOpenSuccessThreshold: 3, // Successes needed to close
};

export interface CircuitBreakerStatus {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number | null;
  timeToRecovery: number | null;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number | null = null;
  private readonly config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should transition from OPEN to HALF_OPEN
    this.checkRecovery();

    // Reject if circuit is open
    if (this.state === CircuitState.OPEN) {
      const timeToRecovery = this.getTimeToRecovery();
      throw new CircuitBreakerOpenError(
        `Circuit breaker is OPEN. Try again in ${Math.ceil(timeToRecovery / 1000)}s`,
        timeToRecovery
      );
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Check if the circuit should transition from OPEN to HALF_OPEN
   */
  private checkRecovery(): void {
    if (this.state === CircuitState.OPEN && this.lastFailureTime !== null) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.recoveryTimeMs) {
        console.error('[CircuitBreaker] Transitioning from OPEN to HALF_OPEN');
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
      }
    }
  }

  /**
   * Record a successful request
   */
  private recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      console.error(
        `[CircuitBreaker] Success in HALF_OPEN (${this.successCount}/${this.config.halfOpenSuccessThreshold})`
      );

      if (this.successCount >= this.config.halfOpenSuccessThreshold) {
        console.error('[CircuitBreaker] Recovery confirmed, transitioning to CLOSED');
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Reset failure count on success
      this.failureCount = 0;
    }
  }

  /**
   * Record a failed request
   */
  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    console.error(
      `[CircuitBreaker] Failure recorded (${this.failureCount}/${this.config.failureThreshold})`
    );

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in HALF_OPEN immediately opens the circuit
      console.error('[CircuitBreaker] Failure in HALF_OPEN, transitioning to OPEN');
      this.state = CircuitState.OPEN;
      this.successCount = 0;
    } else if (this.failureCount >= this.config.failureThreshold) {
      console.error(
        `[CircuitBreaker] Threshold reached (${this.failureCount}), transitioning to OPEN`
      );
      this.state = CircuitState.OPEN;
    }
  }

  /**
   * Get time remaining until recovery attempt
   */
  private getTimeToRecovery(): number {
    if (this.lastFailureTime === null) return 0;
    const elapsed = Date.now() - this.lastFailureTime;
    return Math.max(0, this.config.recoveryTimeMs - elapsed);
  }

  /**
   * Check if the circuit is currently open
   */
  isOpen(): boolean {
    this.checkRecovery();
    return this.state === CircuitState.OPEN;
  }

  /**
   * Get current circuit breaker status
   */
  getStatus(): CircuitBreakerStatus {
    this.checkRecovery();
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      timeToRecovery: this.state === CircuitState.OPEN ? this.getTimeToRecovery() : null,
    };
  }

  /**
   * Get the current state
   */
  getState(): CircuitState {
    this.checkRecovery();
    return this.state;
  }

  /**
   * Manually reset the circuit breaker
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    console.error('[CircuitBreaker] Manually reset to CLOSED');
  }

  /**
   * Force the circuit open (for testing or manual intervention)
   */
  forceOpen(): void {
    this.state = CircuitState.OPEN;
    this.lastFailureTime = Date.now();
    console.error('[CircuitBreaker] Manually forced OPEN');
  }
}

/**
 * Error thrown when circuit breaker is open
 */
export class CircuitBreakerOpenError extends Error {
  readonly timeToRecovery: number;

  constructor(message: string, timeToRecovery: number) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
    this.timeToRecovery = timeToRecovery;
  }
}
