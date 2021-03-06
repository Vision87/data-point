const Promise = require('bluebird')
const set = require('lodash/fp/set')
const debug = require('debug')('data-point-service:cache')
const StaleWhileRevalidate = require('./stale-while-revalidate')
const EntityCacheParams = require('./entity-cache-params')

const RedisController = require('./redis-controller')

/**
 * @param {Function} cacheKey function to generate a cache key
 * @param {DataPoint.Accumulator} ctx DataPoint Accumulator object
 * @returns {String} generated cache key
 */
function generateKey (cacheKey, ctx) {
  return cacheKey ? cacheKey(ctx) : `entity:${ctx.context.id}`
}

/**
 * @param {Service} service Service instance
 * @param {String} entityId entity Id
 * @param {String} entryKey entity cache key
 * @returns {Function<Boolean>} function that returns true
 */
function revalidateSuccess (service, entityId, entryKey) {
  return () => {
    // external revalidation flag is overriden by the new stale state therefore
    // no need to remove the revalidation state externally
    service.staleWhileRevalidate.removeLocalRevalidationFlag(entryKey)
    debug(
      'Succesful revalidation entityId: %s with cache key: %s',
      entityId,
      entryKey
    )
    return true
  }
}

/**
 * @param {Service} service Service instance
 * @param {String} entryKey entity cache key
 * @param {Object} cache cache configuration
 * @returns {Function}
 */
function updateSWREntry (service, entryKey, cache) {
  /**
   * @param {Accumulator} acc
   */
  return acc => {
    debug('Updating cache key: %s with new stale value', entryKey)
    return service.staleWhileRevalidate.addEntry(entryKey, acc.value, cache)
  }
}

/**
 * @param {Service} service Service instance
 * @param {String} entityId entity Id
 * @param {String} entryKey entity cache key
 * @returns {Function}
 */
function catchRevalidateError (service, entityId, entryKey) {
  /**
   * @param {Error} error
   */
  return error => {
    console.error(
      'Could not revalidate entityId: %s with cache key: %s\n',
      entityId,
      entryKey,
      error
    )

    // remove revalidation flags to allow a new revalidation to happen
    // if there is an error at this point will not bubble it up, this is
    // because we are running on a new thread opened in
    // `resolveStaleWhileRevalidateEntry` which at the moment does not provide
    // any custom error handling. PRs welcomed
    return service.staleWhileRevalidate
      .clearAllRevalidationFlags(entryKey)
      .catch(clearError => {
        console.error(
          'Error while clearing revalidation flags for cache key: %s',
          entryKey,
          clearError
        )
      })
  }
}

/**
 * @param {*} staleEntry value of entry stored in cache stores
 * @param {RevalidationState} revalidationState cacheKey's revalidation state
 */
function shouldTriggerRevalidate (staleEntry, revalidationState) {
  // we only want to revalidate if:
  //  - stale response exists
  //  - external control entry has expired (not on SWR_CONTROL_STALE or SWR-CONTROL-REVALIDATING)
  //  - is not currently being revalidated locally
  return (
    typeof staleEntry !== 'undefined' &&
    revalidationState.hasExternalEntryExpired &&
    !revalidationState.isRevalidatingLocally()
  )
}

/**
 * @param {Service} service Service instance
 * @param {String} entryKey entry key
 * @param {Object} cache cache configuration
 * @param {DataPoint.Accumulator} ctx DataPoint Accumulator object
 * @returns {Promise}
 */
function revalidateEntry (service, entryKey, cache, ctx) {
  const entityId = ctx.context.id

  const revalidatingCache = {
    entityId,
    entryKey
  }

  // this object serves as a flag is set to bypass cache middleware execution
  const revalidateContext = set(
    'locals.revalidatingCache',
    revalidatingCache,
    ctx
  )

  debug('Revalidating entityId: %s with cache key: %s', entityId, entryKey)

  const tasks = [
    service.staleWhileRevalidate.addRevalidationFlags(
      entryKey,
      cache.revalidateTimeout
    ),
    service.dataPoint.resolveFromAccumulator(entityId, revalidateContext)
  ]

  const {
    updateSWREntry,
    revalidateSuccess,
    catchRevalidateError
  } = module.exports

  return Promise.all(tasks)
    .then(results => results[1])
    .then(updateSWREntry(service, entryKey, cache))
    .then(revalidateSuccess(service, entityId, entryKey))
    .catch(catchRevalidateError(service, entityId, entryKey))
}

/**
 * Checks if the current entry key is the one being revalidated
 * @param {DataPoint.Accumulator} ctx DataPoint Accumulator object
 * @param {String} currentEntryKey entry key
 * @returns {Boolean} true if revalidating entryKey matches current key
 */
function isRevalidatingCacheKey (ctx, currentEntryKey) {
  const revalidatingCache = ctx.locals.revalidatingCache
  return (revalidatingCache && revalidatingCache.entryKey) === currentEntryKey
}

function resolveStaleWhileRevalidate (service) {
  service.staleWhileRevalidate =
    service.staleWhileRevalidate || StaleWhileRevalidate.create(service)
  return service.staleWhileRevalidate
}

/**
 * If stale entry exists and control entry has expired it will fire a new thread
 * to resolve the entity, this thread is not meant to be chained to the main
 * Promise chain.
 *
 * When this function returns undefined it is telling the caller it should
 * make a standard resolution of the entity instead of using the
 * stale-while-revalidate process.
 *
 * @param {Service} service Service instance
 * @param {String} entryKey entry key
 * @param {Object} cache cache configuration
 * @param {DataPoint.Accumulator} ctx DataPoint Accumulator object
 * @returns {Promise<Object|undefined>} cached stale value
 */
function resolveStaleWhileRevalidateEntry (service, entryKey, cache, ctx) {
  // NOTE: pulling through module.exports allows us to test if they were called
  const {
    resolveStaleWhileRevalidate,
    isRevalidatingCacheKey,
    shouldTriggerRevalidate,
    revalidateEntry
  } = module.exports

  // IMPORTANT: we only want to bypass an entity that is being revalidated and
  // that matches the same cache entry key, otherwise all child entities will
  // be needlesly resolved
  if (isRevalidatingCacheKey(ctx, entryKey)) {
    // bypass the rest forces entity to get resolved
    return undefined
  }

  const staleWhileRevalidate = resolveStaleWhileRevalidate(service)

  // cleanup on a new tick so it does not block current process, the clear
  // method is throttled for performance
  setTimeout(staleWhileRevalidate.invalidateLocalFlags, 0)

  const tasks = [
    staleWhileRevalidate.getRevalidationState(entryKey),
    staleWhileRevalidate.getEntry(entryKey)
  ]

  return Promise.all(tasks).then(results => {
    const revalidationState = results[0]
    const staleEntry = results[1]

    if (shouldTriggerRevalidate(staleEntry, revalidationState)) {
      // IMPORTANT: revalidateEntry operates on a new thread
      revalidateEntry(service, entryKey, cache, ctx)
    } // Otherwise means its a cold start and must be resolved outside

    // return stale entry regardless
    return staleEntry
  })
}

/**
 * @param {Service} service Service instance
 * @param {String} entryKey entry key
 * @param {*} value value to be added to cache store
 * @param {Object} cache cache configuration
 * @returns {Promise} Resolution of adding an entry to the cache
 */
function setStaleWhileRevalidateEntry (service, entryKey, value, cache) {
  const staleWhileRevalidate = module.exports.resolveStaleWhileRevalidate(
    service
  )
  return staleWhileRevalidate.addEntry(entryKey, value, cache)
}

/**
 * @param {Service} service Service instance
 * @param {DataPoint.Accumulator} ctx DataPoint Accumulator object
 * @param {Function} next Middleware callback
 */
function before (service, ctx, next) {
  const { generateKey, resolveStaleWhileRevalidateEntry } = module.exports

  const cache = EntityCacheParams.getCacheParams(ctx.context.params)

  if (!cache.ttl || ctx.locals.resetCache === true) {
    next()
    return false
  }

  const entryKey = generateKey(cache.cacheKey, ctx)

  Promise.resolve(cache.useStaleWhileRevalidate)
    .then(useStaleWhileRevalidate => {
      return useStaleWhileRevalidate
        ? resolveStaleWhileRevalidateEntry(service, entryKey, cache, ctx)
        : RedisController.getEntry(service, entryKey)
    })
    .then(value => {
      if (value !== undefined) {
        ctx.resolve(value)
      }
    })
    .asCallback(next)

  return true
}

/**
 * @param {Service} service Service instance
 * @param {DataPoint.Accumulator} ctx DataPoint Accumulator object
 * @param {Function} next Middleware callback
 */
function after (service, ctx, next) {
  const { generateKey, setStaleWhileRevalidateEntry } = module.exports

  const cache = EntityCacheParams.getCacheParams(ctx.context.params)

  // do nothing if:
  // - cache is not configured, or
  // - its at the process of revalidating, then lets skip any further calls
  if (!cache.ttl || ctx.locals.revalidatingCache) {
    // do nothing
    next()
    return false
  }

  // from here below ttl is assumed to be true
  const entryKey = generateKey(cache.cacheKey, ctx)

  let resolution

  if (cache.useStaleWhileRevalidate) {
    // adds (or updates) the stale cache entry with the latest value
    resolution = setStaleWhileRevalidateEntry(
      service,
      entryKey,
      ctx.value,
      cache
    )
  } else {
    // adds a cache entry
    resolution = RedisController.setEntry(
      service,
      entryKey,
      ctx.value,
      cache.ttl
    )
  }

  resolution.asCallback(next)

  return true
}

module.exports = {
  generateKey,
  isRevalidatingCacheKey,
  resolveStaleWhileRevalidate,
  resolveStaleWhileRevalidateEntry,
  setStaleWhileRevalidateEntry,
  revalidateEntry,
  revalidateSuccess,
  updateSWREntry,
  catchRevalidateError,
  shouldTriggerRevalidate,
  before,
  after
}
