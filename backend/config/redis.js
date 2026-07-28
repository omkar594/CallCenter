import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

let redis;
let isRedisConnected = false;

const mockRedis = {
  get: async () => null,
  set: async () => 'OK',
  del: async () => 1,
  keys: async () => [],
  hset: async () => 1,
  hget: async () => null,
  hgetall: async () => ({}),
  hdel: async () => 1,
  incr: async () => 1,
  on: () => {}
};

try {
  redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy(times) {
      if (times > 1) {
        console.warn('⚠️  Redis server is offline. Backend is operating in Standalone Mode without Redis.');
        return null; // Stop reconnecting
      }
      return 100;
    }
  });

  redis.on('error', (err) => {
    // Suppress console spam if Redis is offline
    if (err.code === 'ECONNREFUSED' || err.message.includes('ECONNREFUSED')) {
      return;
    }
    console.error('Redis client error:', err.message);
  });

  redis.on('connect', () => {
    isRedisConnected = true;
    console.log('Connected to Redis server');
  });

  redis.on('end', () => {
    isRedisConnected = false;
    console.log('Redis client connection closed permanently. Operating in offline mock mode.');
  });
} catch (e) {
  console.warn('Failed to initialize Redis. Using mock fallback.', e.message);
  redis = mockRedis;
}

// Proxy wrapper to fallback to mock if connection is down
const redisProxy = new Proxy({}, {
  get(target, prop) {
    if (isRedisConnected && redis && typeof redis[prop] === 'function') {
      return (...args) => redis[prop](...args).catch(err => {
        console.warn(`Redis command '${prop}' failed, falling back to mock:`, err.message);
        return typeof mockRedis[prop] === 'function' ? mockRedis[prop](...args) : null;
      });
    }
    return mockRedis[prop] || (() => null);
  }
});

export default redisProxy;
