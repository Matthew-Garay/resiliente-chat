'use strict';

/**
 * Cubeta de fichas: permite ráfagas de `capacity` mensajes y luego
 * `refillPerSec` mensajes por segundo.
 */
function createRateLimiter({ capacity, refillPerSec }, now = () => Date.now()) {
  let tokens = capacity;
  let last = now();

  return {
    take() {
      const t = now();
      tokens = Math.min(capacity, tokens + ((t - last) / 1000) * refillPerSec);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

module.exports = { createRateLimiter };
