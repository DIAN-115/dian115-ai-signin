const TOTER_API_ROOT = '/api'
const TOTER_PATHS = {
  login: '/auth/login',
  me: '/auth/me',
  signin: '/user/signin'
}
const PLUGIN_ID = 'toter.daily.signin'
const HISTORY_KEY = 'sign-history'
const SCHEDULE_STATE_KEY = 'schedule-state'
const DEFAULT_SIGN_TIME = '00:01'

function fail(message, code = 'failed') {
  throw Object.assign(new Error(message), { code })
}

function generateAccountId() {
  return 'acct-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function normalizeTime(input) {
  const value = String(input || '').trim()
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return DEFAULT_SIGN_TIME
  return value
}

function normalizeBaseUrl(input) {
  let value = String(input || '').trim().replace(/\/+$/, '')
  if (!value) fail('请先在插件页面填写站点地址。', 'invalid_input')
  if (!/^https?:\/\//.test(value)) value = 'https://' + value
  try {
    return new URL(value).origin
  } catch {
    fail('站点地址格式不正确', 'invalid_input')
  }
}

function parseBody(response) {
  if (response.data !== undefined && response.data !== null) return response.data
  if (!response.body) return null
  try {
    return JSON.parse(response.body)
  } catch {
    return null
  }
}

async function requestJson(ctx, options) {
  const response = await ctx.http.request({
    response_type: 'json',
    timeout_seconds: 30,
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  })
  return { status: response.status, body: parseBody(response), raw: response }
}

function messageOf(body, fallback) {
  return body?.message || body?.msg || body?.data?.message || body?.data?.msg || fallback
}

function textOf(body) {
  return [body?.message, body?.msg, body?.data?.message, body?.data?.msg, JSON.stringify(body?.data || {})]
    .filter(Boolean)
    .join(' ')
}

function isAlreadySignedIn(body) {
  const text = textOf(body)
  return /已签到|今日已签|已经签到|重复签到|已完成签到|already\s*(signed|check)|signed\s*(in|today)|checked\s*in/i.test(text)
}

function pickAccount(account) {
  if (!account || typeof account !== 'object') return {}
  return {
    id: account.id,
    username: account.username,
    email: account.email,
    nickname: account.nickname || account.name
  }
}

function summarizeData(data) {
  if (!data || typeof data !== 'object') return ''
  const keys = ['quota', 'permanentQuota', 'dailyQuota', 'isVip', 'nudge', 'reward', 'rewardQuota', 'amount', 'checked_in', 'points']
  const parts = []
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null) parts.push(`${key}: ${data[key]}`)
  }
  return parts.join('，')
}

function normalizeAccount(input, previous = null) {
  const raw = input || {}
  const id = previous?.id || raw.id || generateAccountId()
  const baseUrl = normalizeBaseUrl(raw.base_url || previous?.base_url)
  const username = String(raw.username || '').trim()
  const password = raw.password !== undefined && raw.password !== '' ? String(raw.password) : String(previous?.password || '')
  const name = String(raw.name || username || 'AI 账号').trim().slice(0, 40)

  if (!username) fail('请填写用户名或邮箱。', 'invalid_input')
  if (!password) fail('请填写密码。', 'invalid_input')

  return {
    id,
    name: name || username,
    base_url: baseUrl,
    username,
    password,
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    createdAt: previous?.createdAt || Date.now()
  }
}

function unwrapStorageValue(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.revision !== undefined && raw.value !== undefined) {
    return raw.value
  }
  return raw
}

function normalizeSettings(input) {
  const raw = unwrapStorageValue(input) || {}
  const rawAccounts = Array.isArray(raw.accounts) ? raw.accounts : []
  let accounts = []

  if (rawAccounts.length) {
    accounts = rawAccounts
      .filter(item => item && typeof item === 'object')
      .map(item => normalizeAccount(item))
  } else if (raw.username || raw.password) {
    accounts = [normalizeAccount({
      id: 'toter',
      name: 'AI 账号',
      base_url: raw.base_url,
      username: raw.username,
      password: raw.password,
      enabled: true
    })]
  }

  const seen = new Set()
  accounts = accounts.filter(account => {
    if (seen.has(account.id)) return false
    seen.add(account.id)
    return true
  })

  return {
    notify_success: raw.notify_success !== false,
    notify_failure: raw.notify_failure !== false,
    sign_time: normalizeTime(raw.sign_time),
    accounts
  }
}

async function toterLogin(ctx, session, baseUrl, username, password) {
  await ctx.http.request({ url: baseUrl + '/login', session, timeout_seconds: 30 })
  const login = await requestJson(ctx, {
    url: baseUrl + TOTER_API_ROOT + TOTER_PATHS.login,
    session,
    method: 'POST',
    body: JSON.stringify({ username, password, rememberMe: true })
  })

  if (login.status >= 400 || login.body?.success === false) {
    const code = login.status === 401 || login.status === 403 ? 'forbidden' : 'invalid_input'
    fail(messageOf(login.body, `登录失败（HTTP ${login.status}）`), code)
  }

  const me = await requestJson(ctx, {
    url: baseUrl + TOTER_API_ROOT + TOTER_PATHS.me,
    session,
    method: 'GET'
  })
  if (me.status === 401 || me.body?.success === false) {
    fail('登录后仍未取得有效会话，请检查账号密码，或确认站点是否需要额外人工验证。', 'forbidden')
  }
  if (me.status >= 400) {
    fail(`登录后校验账号状态失败（HTTP ${me.status}）`, 'upstream')
  }
  return me.body?.data || me.body || {}
}

async function toterEnsureSession(ctx, session, baseUrl, username, password) {
  const me = await requestJson(ctx, {
    url: baseUrl + TOTER_API_ROOT + TOTER_PATHS.me,
    session,
    method: 'GET'
  })
  if (me.status === 401 || me.body?.success === false) {
    await ctx.task.log(`${username} 当前会话未登录，使用插件设置中的账号登录`)
    return toterLogin(ctx, session, baseUrl, username, password)
  }
  if (me.status >= 400) {
    fail(`站点状态异常（HTTP ${me.status}）`, 'upstream')
  }
  return me.body?.data || me.body || {}
}

async function runAccount(ctx, account) {
  const session = `toter-signin-${account.id}`
  const baseUrl = normalizeBaseUrl(account.base_url)

  await ctx.task.update({ stage: 'account_auth', message: `${account.name}：检查登录状态` })
  const profile = await toterEnsureSession(ctx, session, baseUrl, account.username, account.password)

  await ctx.task.checkpoint({
    step: `account:${account.id}:before_signin`,
    at: new Date().toISOString(),
    accountId: account.id,
    site: baseUrl,
    account: pickAccount(profile)
  })

  await ctx.task.update({ stage: 'account_signin', message: `${account.name}：提交每日签到` })
  let signin = await requestJson(ctx, {
    url: baseUrl + TOTER_API_ROOT + TOTER_PATHS.signin,
    session,
    method: 'POST'
  })

  if (signin.status === 401) {
    await ctx.task.log(`${account.name} 签到会话已失效，重新登录后重试一次`)
    const refreshed = await toterLogin(ctx, session, baseUrl, account.username, account.password)
    signin = await requestJson(ctx, {
      url: baseUrl + TOTER_API_ROOT + TOTER_PATHS.signin,
      session,
      method: 'POST'
    })
    Object.assign(profile, pickAccount(refreshed))
  }

  let outcome = 'success'
  let message = messageOf(signin.body, '签到成功')
  const data = signin.body?.data || null

  if (signin.status >= 400 || signin.body?.success === false) {
    if (isAlreadySignedIn(signin.body)) {
      outcome = 'already'
      message = messageOf(signin.body, '今日已签到')
    } else {
      const code = signin.status === 401 || signin.status === 403 ? 'forbidden' : 'upstream'
      fail(messageOf(signin.body, `签到失败（HTTP ${signin.status}）`), code)
    }
  }

  return {
    id: account.id,
    site: account.name,
    baseUrl,
    account: pickAccount(profile),
    outcome,
    message,
    data,
    detail: summarizeData(data)
  }
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function timeKey(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function aggregateOutcome(sites) {
  const outcomes = Object.values(sites).map(item => item?.outcome).filter(Boolean)
  if (!outcomes.length) return 'skipped'
  if (outcomes.includes('failed')) return 'failed'
  if (outcomes.includes('success')) return 'success'
  if (outcomes.includes('already')) return 'already'
  return 'skipped'
}

function siteLine(site) {
  if (!site) return ''
  const label = site.outcome === 'success' ? '签到成功' : site.outcome === 'already' ? '今日已签到' : site.outcome === 'skipped' ? '已跳过' : '签到失败'
  const detail = site.detail ? `（${site.detail}）` : ''
  return `${site.site}：${label} - ${site.message || '-'}${detail}`
}

async function updateHistory(ctx, result) {
  const today = todayKey()
  let history = await ctx.storage.get(HISTORY_KEY)
  if (!history || typeof history !== 'object' || Array.isArray(history)) history = {}

  for (const [accountId, site] of Object.entries(result.sites || {})) {
    const entry = history[accountId] && typeof history[accountId] === 'object'
      ? history[accountId]
      : { dates: [], lastStatus: '', lastDetail: '', lastAt: 0, total: 0 }

    entry.lastStatus = site?.outcome || result.outcome || 'failed'
    entry.lastDetail = site?.message || result.message || ''
    entry.lastAt = result.at ? new Date(result.at).getTime() : Date.now()

    if (['success', 'already'].includes(entry.lastStatus)) {
      if (!entry.dates.includes(today)) entry.dates.push(today)
      entry.dates = entry.dates.slice(-400)
    }
    entry.total = entry.dates.length
    history[accountId] = entry
  }

  await ctx.storage.set(HISTORY_KEY, history)
}

async function deliverNotification(ctx, payload) {
  const attempts = []
  const senders = [
    ['notifications.send', typeof ctx.notifications?.send === 'function' ? ctx.notifications.send.bind(ctx.notifications) : null],
    ['notify', typeof ctx.notify === 'function' ? ctx.notify.bind(ctx) : null],
    ['api.notify', typeof ctx.api?.post === 'function' ? async () => ctx.api.post(`/api/extensions/v3/${ctx.id || PLUGIN_ID}/notify`, payload) : null]
  ]

  for (const [name, sender] of senders) {
    if (!sender) continue
    try {
      return await sender(payload)
    } catch (error) {
      attempts.push(`${name}: ${error.message}`)
    }
  }
  throw new Error(attempts.length ? attempts.join('；') : '通知发送能力不可用')
}

async function notifySuccess(ctx, result) {
  const body = Object.values(result.sites).map(siteLine).filter(Boolean).join('\n')
  await deliverNotification(ctx, {
    title: result.outcome === 'already' ? 'AI 签到：今日已签到' : 'AI 签到成功',
    body,
    level: result.outcome === 'already' ? 'info' : 'success',
    dedupe_key: `ai-signin:${todayKey()}:${result.outcome}`
  })
}

async function notifyFailure(ctx, result, failures) {
  const body = [
    Object.values(result.sites).map(siteLine).filter(Boolean).join('\n'),
    failures.map(item => `${item.site}：${item.error.message}`).join('\n')
  ].filter(Boolean).join('\n')
  await deliverNotification(ctx, {
    title: 'AI 签到失败',
    body,
    level: 'error',
    dedupe_key: `ai-signin:fail:${todayKey()}:${failures.map(item => item.id || item.site).join(',')}`
  })
}

export async function run(ctx, input) {
  const rawSettings = await ctx.settings.get()
  const settings = normalizeSettings(rawSettings)

  const isManual = input?.source === 'page' || Boolean(input?.accountId)
  const now = new Date()
  const targetTime = settings.sign_time || DEFAULT_SIGN_TIME

  if (!isManual) {
    let scheduleState = null
    try {
      scheduleState = unwrapStorageValue(await ctx.storage.get(SCHEDULE_STATE_KEY)) || null
    } catch {
      scheduleState = null
    }

    if (timeKey(now) !== targetTime) {
      return {
        at: now.toISOString(),
        outcome: 'skipped',
        message: `未到计划时间 ${targetTime}`,
        sites: {},
        scheduled: false
      }
    }
    if (scheduleState && scheduleState.date === todayKey(now) && scheduleState.time === targetTime) {
      return {
        at: now.toISOString(),
        outcome: 'skipped',
        message: '今日计划签到已执行',
        sites: {},
        scheduled: true
      }
    }
  }

  let accounts = settings.accounts.filter(account => account.enabled)
  if (input?.accountId) {
    accounts = accounts.filter(account => account.id === input.accountId)
  }

  if (!accounts.length) {
    fail(input?.accountId ? '指定的 AI 账号未启用或不存在。' : '请先在插件页面添加并启用 AI 账号。', 'invalid_input')
  }

  const sites = {}
  const failures = []

  try {
    await ctx.task.checkpoint({ step: 'before_accounts', at: new Date().toISOString(), accountIds: accounts.map(item => item.id) })

    for (const account of accounts) {
      try {
        sites[account.id] = await runAccount(ctx, account)
      } catch (error) {
        sites[account.id] = {
          id: account.id,
          site: account.name,
          baseUrl: account.base_url,
          outcome: 'failed',
          message: error.message,
          code: error.code || 'failed'
        }
        failures.push({ id: account.id, site: account.name, error })
      }
    }

    const outcome = aggregateOutcome(sites)
    const result = {
      at: new Date().toISOString(),
      outcome,
      message: Object.values(sites).map(siteLine).filter(Boolean).join('\n'),
      sites,
      manual: input?.source === 'page'
    }

    await ctx.task.checkpoint({ step: 'done', result })
    await updateHistory(ctx, result)
    await ctx.storage.set('last_result', result)
    await ctx.task.log(`${outcome}: ${result.message}`)

    if (failures.length) {
      if (settings.notify_failure !== false) {
        try {
          await notifyFailure(ctx, result, failures)
        } catch (notifyError) {
          await ctx.task.log(`通知发送失败：${notifyError.message}`)
        }
      }
      const first = failures[0].error
      throw Object.assign(new Error(failures.map(item => `${item.site}：${item.error.message}`).join('；')), { code: first.code || 'failed' })
    }

    if (!isManual) {
      await ctx.storage.set(SCHEDULE_STATE_KEY, { date: todayKey(now), time: targetTime, at: result.at })
    }

    if (settings.notify_success !== false) {
      try {
        await notifySuccess(ctx, result)
      } catch (notifyError) {
        await ctx.task.log(`通知发送失败：${notifyError.message}`)
      }
    }
    return result
  } catch (error) {
    const result = {
      at: new Date().toISOString(),
      outcome: 'failed',
      message: error.message || '未知错误',
      code: error.code || 'failed',
      sites
    }
    await updateHistory(ctx, result)
    await ctx.storage.set('last_result', result)
    throw error
  }
}

export async function recover(ctx, checkpoint) {
  if (!checkpoint) return { action: 'resume' }
  if (checkpoint.step === 'done') return { action: 'complete', result: checkpoint.result }
  if (checkpoint.step === 'before_accounts' || /^account:.*:before_signin$/.test(checkpoint.step || '')) {
    return {
      action: 'attention',
      message: '签到请求是否已生效无法确认，请打开对应站点核对今日签到状态后再手动重试。'
    }
  }
  return { action: 'resume' }
}
