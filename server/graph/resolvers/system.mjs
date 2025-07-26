import _ from 'lodash-es'
import util from 'node:util'
import getosSync from 'getos'
import os from 'node:os'
import { filesize } from 'filesize'
import path from 'node:path'
import fs from 'fs-extra'
import { DateTime } from 'luxon'
import { generateError, generateSuccess } from '../../helpers/graph.mjs'

const getos = util.promisify(getosSync)

export default {
  Query: {
    /**
     * Metrics Endpoint State
     */
    metricsState () {
      return WIKI.config.metrics?.isEnabled ?? false
    },
    /**
     * System Flags
     */
    systemFlags () {
      return WIKI.config.flags
    },
    /**
     * System Info
     */
    async systemInfo (obj, args, context) {
      if (!WIKI.auth.checkAccess(context.req.user, ['read:dashboard', 'manage:sites'])) {
        throw new Error('ERR_FORBIDDEN')
      }

      return {}
    },
    /**
     * System Extensions
     */
    async systemExtensions (obj, args, context) {
      if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
        throw new Error('ERR_FORBIDDEN')
      }

      const exts = Object.values(WIKI.extensions.ext).map(ext => _.pick(ext, ['key', 'title', 'description', 'isInstalled', 'isInstallable']))
      for (const ext of exts) {
        ext.isCompatible = await WIKI.extensions.ext[ext.key].isCompatible()
      }
      return exts
    },
    /**
     * List System Instances
     */
    async systemInstances (obj, args, context) {
      if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
        throw new Error('ERR_FORBIDDEN')
      }

      const instRaw = await WIKI.db.knex('pg_stat_activity')
        .select([
          'usename',
          'client_addr',
          'application_name',
          'backend_start',
          'state_change'
        ])
        .where('datname', WIKI.db.knex.client.connectionSettings.database)
        .andWhereLike('application_name', 'Wiki.js%')
      const insts = {}
      for (const inst of instRaw) {
        const instId = inst.application_name.substring(10, 20)
        const conType = inst.application_name.includes(':MAIN') ? 'main' : 'sub'
        const curInst = insts[instId] ?? {
          activeConnections: 0,
          activeListeners: 0,
          dbFirstSeen: inst.backend_start,
          dbLastSeen: inst.state_change
        }
        insts[instId] = {
          id: instId,
          activeConnections: conType === 'main' ? curInst.activeConnections + 1 : curInst.activeConnections,
          activeListeners: conType === 'sub' ? curInst.activeListeners + 1 : curInst.activeListeners,
          dbUser: inst.usename,
          dbFirstSeen: curInst.dbFirstSeen > inst.backend_start ? inst.backend_start : curInst.dbFirstSeen,
          dbLastSeen: curInst.dbLastSeen < inst.state_change ? inst.state_change : curInst.dbLastSeen,
          ip: inst.client_addr
        }
      }
      return _.values(insts)
    },
    /**
     * System Security Settings
     */
    systemSecurity (obj, args, context) {
      if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
        throw new Error('ERR_FORBIDDEN')
      }

      return WIKI.config.security
    },
    /**
     * List System Jobs
     */
    async systemJobs (obj, args, context) {
      if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
        throw new Error('ERR_FORBIDDEN')
      }

      const results = args.states?.length > 0
        ? await WIKI.db.knex('jobHistory').whereIn('state', args.states.map(s => s.toLowerCase())).orderBy('startedAt', 'desc')
        : await WIKI.db.knex('jobHistory').orderBy('startedAt', 'desc')
      return results.map(r => ({
        ...r,
        state: r.state.toUpperCase()
      }))
    },
    /**
     * List Scheduled Jobs
     */
    async systemJobsScheduled (obj, args, context) {
      if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
        throw new Error('ERR_FORBIDDEN')
      }

      return WIKI.db.knex('jobSchedule').orderBy('task')
    },
    /**
     * List Upcoming Jobs
     */
    async systemJobsUpcoming (obj, args, context) {
      if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
        throw new Error('ERR_FORBIDDEN')
      }

      return WIKI.db.knex('jobs').orderBy([
        { column: 'waitUntil', order: 'asc', nulls: 'first' },
        { column: 'createdAt', order: 'asc' }
      ])
    },
    /**
     * Search Settings
     */
    systemSearch (obj, args, context) {
      if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
        throw new Error('ERR_FORBIDDEN')
      }

      return {
        ...WIKI.config.search,
        dictOverrides: JSON.stringify(WIKI.config.search.dictOverrides, null, 2)
      }
    }
  },
  Mutation: {
    async cancelJob (obj, args, context) {
      try {
        if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
          throw new Error('ERR_FORBIDDEN')
        }

        WIKI.logger.info(`Admin requested cancelling job ${args.id}...`)

        const result = await WIKI.db.knex('jobs')
          .where('id', args.id)
          .del()
        if (result === 1) {
          WIKI.logger.info(`Cancelled job ${args.id} [ OK ]`)
        } else {
          throw new Error('Job has already entered active state or does not exist.')
        }
        return {
          operation: generateSuccess('Cancelled job successfully.')
        }
      } catch (err) {
        if (err.message !== 'ERR_FORBIDDEN') {
          WIKI.logger.warn(err)
        }
        return generateError(err)
      }
    },
    async checkForUpdates (obj, args, context) {
      try {
        if (!WIKI.auth.checkAccess(context.req.user, ['read:dashboard', 'manage:system'])) {
          throw new Error('ERR_FORBIDDEN')
        }

        const renderJob = await WIKI.scheduler.addJob({
          task: 'checkVersion',
          maxRetries: 0,
          promise: true
        })
        await renderJob.promise
        return {
          operation: generateSuccess('Checked for latest version successfully.'),
          current: WIKI.version,
          latest: WIKI.config.update.version,
          latestDate: WIKI.config.update.versionDate
        }
      } catch (err) {
        if (err.message !== 'ERR_FORBIDDEN') {
          WIKI.logger.warn(err)
        }
        return generateError(err)
      }
    },
    async disconnectWS (obj, args, context) {
      try {
        if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
          throw new Error('ERR_FORBIDDEN')
        }

        WIKI.servers.ws.disconnectSockets(true)
        WIKI.logger.info('All active websocket connections have been terminated.')
        return {
          operation: generateSuccess('All websocket connections closed successfully.')
        }
      } catch (err) {
        if (err.message !== 'ERR_FORBIDDEN') {
          WIKI.logger.warn(err)
        }
        return generateError(err)
      }
    },
    async installExtension (obj, args, context) {
      try {
        if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
          throw new Error('ERR_FORBIDDEN')
        }

        await WIKI.extensions.ext[args.key].install()
        // TODO: broadcast ext install
        return {
          operation: generateSuccess('Extension installed successfully')
        }
      } catch (err) {
        return generateError(err)
      }
    },
    async rebuildSearchIndex (obj, args, context) {
      try {
        if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
          throw new Error('ERR_FORBIDDEN')
        }

        await WIKI.scheduler.addJob({
          task: 'rebuildSearchIndex',
          maxRetries: 0
        })
        return {
          operation: generateSuccess('Search index rebuild has been scheduled and will start shortly.')
        }
      } catch (err) {
        return generateError(err)
      }
    },
    async retryJob (obj, args, context) {
      try {
        if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
          throw new Error('ERR_FORBIDDEN')
        }

        WIKI.logger.info(`Admin requested rescheduling of job ${args.id}...`)

        const job = await WIKI.db.knex('jobHistory')
          .where('id', args.id)
          .first()
        if (!job) {
          throw new Error('No such job found.')
        } else if (job.state === 'interrupted') {
          throw new Error('Cannot reschedule a task that has been interrupted. It will automatically be retried shortly.')
        } else if (job.state === 'failed' && job.attempt < job.maxRetries) {
          throw new Error('Cannot reschedule a task that has not reached its maximum retry attempts.')
        }
        await WIKI.db.knex('jobs')
          .insert({
            id: job.id,
            task: job.task,
            useWorker: job.useWorker,
            payload: job.payload,
            retries: job.attempt,
            maxRetries: job.maxRetries,
            isScheduled: job.wasScheduled,
            createdBy: WIKI.INSTANCE_ID
          })
        WIKI.logger.info(`Job ${args.id} has been rescheduled [ OK ]`)
        return {
          operation: generateSuccess('Job rescheduled successfully.')
        }
      } catch (err) {
        WIKI.logger.warn(err)
        return generateError(err)
      }
    },
    /**
     * Set Metrics endpoint state
     */
    async setMetricsState (obj, args, context) {
      try {
        if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
          throw new Error('ERR_FORBIDDEN')
        }

        WIKI.config.metrics.isEnabled = args.enabled
        await WIKI.configSvc.saveToDb(['metrics'])
        return {
          operation: generateSuccess('Metrics endpoint state changed successfully')
        }
      } catch (err) {
        return generateError(err)
      }
    },
    async updateSystemFlags (obj, args, context) {
      try {
        if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
          throw new Error('ERR_FORBIDDEN')
        }

        WIKI.config.flags = {
          ...WIKI.config.flags,
          ...args.flags
        }
        await WIKI.configSvc.applyFlags()
        await WIKI.configSvc.saveToDb(['flags'])
        return {
          operation: generateSuccess('System Flags applied successfully')
        }
      } catch (err) {
        WIKI.logger.warn(err)
        return generateError(err)
      }
    },
    async updateSystemSearch (obj, args, context) {
      try {
        if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
          throw new Error('ERR_FORBIDDEN')
        }

        WIKI.config.search = {
          ...WIKI.config.search,
          termHighlighting: args.termHighlighting ?? WIKI.config.search.termHighlighting,
          dictOverrides: args.dictOverrides ? JSON.parse(args.dictOverrides) : WIKI.config.search.dictOverrides
        }
        // TODO: broadcast config update
        await WIKI.configSvc.saveToDb(['search'])
        return {
          operation: generateSuccess('System Search configuration applied successfully')
        }
      } catch (err) {
        WIKI.logger.warn(err)
        return generateError(err)
      }
    },
    async updateSystemSecurity (obj, args, context) {
      try {
        if (!WIKI.auth.checkAccess(context.req.user, ['manage:system'])) {
          throw new Error('ERR_FORBIDDEN')
        }

        WIKI.config.security = _.defaultsDeep(_.omit(args, ['__typename']), WIKI.config.security)
        // TODO: broadcast config update
        await WIKI.configSvc.saveToDb(['security'])
        return {
          operation: generateSuccess('System Security configuration applied successfully')
        }
      } catch (err) {
        WIKI.logger.warn(err)
        return generateError(err)
      }
    }
  },
  SystemInfo: {
    configFile () {
      return path.join(process.cwd(), 'config.yml')
    },
    cpuCores () {
      return os.cpus().length
    },
    currentVersion () {
      return WIKI.version
    },
    dbHost () {
      return WIKI.config.db.host
    },
    dbVersion () {
      return WIKI.db.VERSION
    },
    hostname () {
      return os.hostname()
    },
    httpPort () {
      return WIKI.servers.servers.http ? _.get(WIKI.servers.servers.http.address(), 'port', 0) : 0
    },
    httpRedirection () {
      return _.get(WIKI.config, 'server.sslRedir', false)
    },
    httpsPort () {
      return WIKI.servers.servers.https ? _.get(WIKI.servers.servers.https.address(), 'port', 0) : 0
    },
    isMailConfigured () {
      return WIKI.config?.mail?.host?.length > 2
    },
    async isSchedulerHealthy () {
      const results = await WIKI.db.knex('jobHistory').count('* as total').whereIn('state', ['failed', 'interrupted']).andWhere('startedAt', '>=', DateTime.utc().minus({ days: 1 }).toISO()).first()
      return _.toSafeInteger(results?.total) === 0
    },
    latestVersion () {
      return WIKI.config.update.version
    },
    latestVersionReleaseDate () {
      return DateTime.fromISO(WIKI.config.update.versionDate).toJSDate()
    },
    nodeVersion () {
      return process.version.substring(1)
    },
    async operatingSystem () {
      let osLabel = `${os.type()} (${os.platform()}) ${os.release()} ${os.arch()}`
      if (os.platform() === 'linux') {
        const osInfo = await getos()
        osLabel = `${os.type()} - ${osInfo.dist} (${osInfo.codename || os.platform()}) ${osInfo.release || os.release()} ${os.arch()}`
      }
      return osLabel
    },
    async platform () {
      const isDockerized = await fs.pathExists('/.dockerenv')
      if (isDockerized) {
        return 'docker'
      }
      return os.platform()
    },
    ramTotal () {
      return filesize(os.totalmem())
    },
    sslDomain () {
      return WIKI.config.ssl.enabled && WIKI.config.ssl.provider === 'letsencrypt' ? WIKI.config.ssl.domain : null
    },
    sslExpirationDate () {
      return WIKI.config.ssl.enabled && WIKI.config.ssl.provider === 'letsencrypt' ? _.get(WIKI.config.letsencrypt, 'payload.expires', null) : null
    },
    sslProvider () {
      return WIKI.config.ssl.enabled ? WIKI.config.ssl.provider : null
    },
    sslStatus () {
      return 'OK'
    },
    sslSubscriberEmail () {
      return WIKI.config.ssl.enabled && WIKI.config.ssl.provider === 'letsencrypt' ? WIKI.config.ssl.subscriberEmail : null
    },
    async upgradeCapable () {
      return !_.isNil(process.env.UPGRADE_COMPANION)
    },
    workingDirectory () {
      return process.cwd()
    },
    async groupsTotal () {
      const total = await WIKI.db.groups.query().count('* as total').first()
      return _.toSafeInteger(total.total)
    },
    async pagesTotal () {
      const total = await WIKI.db.pages.query().count('* as total').first()
      return _.toSafeInteger(total.total)
    },
    async tagsTotal () {
      const total = await WIKI.db.tags.query().count('* as total').first()
      return _.toSafeInteger(total.total)
    },
    async usersTotal () {
      const total = await WIKI.db.users.query().count('* as total').first()
      return _.toSafeInteger(total.total)
    },
    async loginsPastDay () {
      const total = await WIKI.db.users.query().count('* as total').whereRaw('"lastLoginAt" >= NOW() - INTERVAL \'1 DAY\'').first()
      return _.toSafeInteger(total.total)
    }
  }
}
