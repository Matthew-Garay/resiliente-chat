'use strict';

/**
 * Cubeta de fichas: permite ráfagas de `capacity` unidades y luego
 * `refillPerSec` unidades por segundo.
 */
function createRateLimiter({ capacity, refillPerSec }, now = () => Date.now()) {
  let tokens = capacity;
  let last = now();

  return {
    /** Gasta `cost` fichas (1 por trama, o N bytes). Devuelve false si no hay suficientes. */
    take(cost = 1) {
      const t = now();
      tokens = Math.min(capacity, tokens + ((t - last) / 1000) * refillPerSec);
      last = t;
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    },
  };
}

module.exports = { createRateLimiter };
