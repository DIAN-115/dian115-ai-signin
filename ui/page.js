// AI 签到助手页面：多账号配置保存在插件私有设置/历史，后台任务完成登录与签到。
const $ = id => document.getElementById(id)
const PLUGIN_ID = 'toter.daily.signin'
const HISTORY_KEY = 'sign-history'
const CIRC = 2 * Math.PI * 82
const DEFAULT_SIGN_TIME = '00:01'

let ctxRef = null
let current = { notify_success: true, notify_failure: true, sign_time: DEFAULT_SIGN_TIME, accounts: [] }
let lastResult = null
let history = {}
let running = false
let editingId = null
let pollTimer = null
let clockTimer = null
let disposers = []

function on(target, type, fn, options) {
  target.addEventListener(type, fn, options)
  disposers.push(() => target.removeEventListener(type, fn, options))
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function normalizeTime(input) {
  const value = String(input || '').trim()
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return DEFAULT_SIGN_TIME
  return value
}

function hostOf(url) {
  try { return new URL(String(url)).hostname } catch { return String(url || '未配置站点') }
}

function normalizeUrl(input) {
  let value = String(input || '').trim().replace(/\/+$/, '')
  if (!value) throw new Error('empty_url')
  if (!/^https?:\/\//.test(value)) value = 'https://' + value
  return new URL(value).origin
}

function uid() {
  return 'acct-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function statusText(status) {
  return {
    success: '签到成功',
    already: '今日已签',
    failed: '签到失败',
    skipped: '已跳过',
    pending: '待签到'
  }[status] || '待签到'
}

function unwrapStorageValue(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.revision !== undefined && raw.value !== undefined) {
    return raw.value
  }
  return raw
}

function migrateSettings(raw) {
  const source = raw || {}
  const rawAccounts = Array.isArray(source.accounts) ? source.accounts : []
  let accounts = []

  if (rawAccounts.length) {
    accounts = rawAccounts
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        id: String(item.id || uid()),
        name: String(item.name || item.username || 'AI 账号').trim().slice(0, 40),
        base_url: String(item.base_url || ''),
        username: String(item.username || '').trim(),
        password: String(item.password || ''),
        enabled: item.enabled === undefined ? true : Boolean(item.enabled),
        createdAt: item.createdAt || Date.now()
      }))
  } else if (source.username || source.password) {
    accounts.push({
      id: 'toter',
      name: 'AI 账号',
      base_url: String(source.base_url || ''),
      username: String(source.username || '').trim(),
      password: String(source.password || ''),
      enabled: true,
      createdAt: Date.now()
    })
  }

  const seen = new Set()
  accounts = accounts.filter(account => {
    if (seen.has(account.id)) return false
    seen.add(account.id)
    return true
  })

  return {
    notify_success: source.notify_success !== false,
    notify_failure: source.notify_failure !== false,
    sign_time: normalizeTime(source.sign_time),
    accounts
  }
}

function getAccount(id) {
  return current.accounts.find(account => account.id === id) || null
}

function historyEntry(id) {
  return history[id] && typeof history[id] === 'object' ? history[id] : { dates: [], lastStatus: '', lastDetail: '', lastAt: 0, total: 0 }
}

function siteFor(id) {
  return lastResult?.sites?.[id] || null
}

function todayStatus(id) {
  const site = siteFor(id)
  if (lastResult?.at && dayKey(lastResult.at) !== dayKey()) return ''
  return site?.outcome || ''
}

function streakOf(dates, today = dayKey()) {
  const done = new Set(dates || [])
  const cursor = new Date(today + 'T12:00:00')
  if (!done.has(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1)
  let n = 0
  for (let i = 0; i < 3660; i++) {
    if (!done.has(dayKey(cursor.getTime()))) break
    n++
    cursor.setDate(cursor.getDate() - 1)
  }
  return n
}

function toast(message, kind = 'info') {
  const stack = $('toasts')
  if (!stack) return
  const node = document.createElement('div')
  node.className = `toast ${kind}`
  node.innerHTML = `<span class="t-ico"></span><span>${escapeHtml(message)}</span>`
  stack.appendChild(node)
  setTimeout(() => {
    node.classList.add('out')
    setTimeout(() => node.remove(), 260)
  }, 3200)
}

function describeNotify(res, prefix) {
  if (!res) { toast(prefix + '：无返回结果', 'err'); return }
  if (res.error) { toast(prefix + '失败：' + res.error, 'err'); return }
  if (res.skipped) { toast(prefix + '：未发送（' + (res.reason || '未开启') + '）', 'info'); return }
  const deliveries = Array.isArray(res.deliveries) ? res.deliveries : []
  if (!deliveries.length) {
    toast(res.accepted ? prefix + '：宿主已接收（无渠道明细）' : prefix + '：宿主未接收', res.accepted ? 'ok' : 'err')
    return
  }
  const sent = deliveries.filter(d => d.status === 'sent')
  if (sent.length) {
    toast(prefix + '已送达：' + sent.map(d => d.channel).join('、'), 'ok')
  } else {
    const reasons = deliveries.map(d => {
      const why = { not_configured: '未配置', disabled: '已禁用', quiet_hours: '静默时段' }[d.reason] || d.reason || d.status
      return `${d.channel} ${why}`
    }).join('；')
    toast(prefix + '未送达：' + reasons, 'err')
  }
}

async function sendNotification(payload) {
  const ctx = ctxRef
  if (ctx.notifications?.send) return ctx.notifications.send(payload)
  if (typeof ctx.notify === 'function') return ctx.notify(payload)
  if (typeof ctx.api?.post === 'function') {
    return ctx.api.post(`/api/extensions/v3/${ctx.id || PLUGIN_ID}/notify`, payload)
  }
  throw new Error('当前宿主未提供通知发送能力')
}

function renderClock() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  $('clock').textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function renderHeatmap() {
  const grid = $('heatmap')
  grid.innerHTML = ''
  for (const label of ['一', '二', '三', '四', '五', '六', '日']) {
    const cell = document.createElement('div')
    cell.className = 'heat-head'
    cell.textContent = label
    grid.appendChild(cell)
  }

  const counts = {}
  for (const entry of Object.values(history || {})) {
    const dates = Array.isArray(entry?.dates) ? entry.dates : []
    for (const date of dates) counts[date] = (counts[date] || 0) + 1
  }

  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const mondayOffset = (today.getDay() + 6) % 7
  const start = new Date(today)
  start.setDate(start.getDate() - mondayOffset - 28)
  const todayStr = dayKey()

  for (let i = 0; i < 35; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = dayKey(d.getTime())
    const count = counts[key] || 0
    const level = count === 0 ? 0 : count === 1 ? 1 : count === 2 ? 2 : 3
    const cell = document.createElement('div')
    cell.className = `heat-cell l${level}${key === todayStr ? ' today' : ''}`
    cell.textContent = d.getDate()
    cell.title = `${key}：${count ? `已签到 ${count} 个账号` : '未签到'}`
    grid.appendChild(cell)
  }
}

function renderTimeline() {
  const list = $('timeline')
  list.innerHTML = ''
  const rows = []

  for (const account of current.accounts) {
    const entry = historyEntry(account.id)
    const site = siteFor(account.id)
    const status = site?.outcome || entry.lastStatus || ''
    const detail = site?.message || entry.lastDetail || ''
    const ts = site && lastResult?.at ? new Date(lastResult.at).getTime() : entry.lastAt || 0
    if (status || ts) rows.push({ name: account.name, status, detail, ts })
  }

  rows.sort((a, b) => b.ts - a.ts)
  const visible = rows.slice(0, 10)
  $('timeline-empty').hidden = visible.length > 0

  for (const row of visible) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="tl-dot ${escapeHtml(row.status || 'pending')}"></span>
      <span class="tl-name">${escapeHtml(row.name)}</span>
      <span class="tl-detail">${escapeHtml(statusText(row.status))}${row.detail ? ' · ' + escapeHtml(row.detail) : ''}</span>
      <span class="tl-time">${fmtTime(row.ts)}</span>`
    list.appendChild(li)
  }
}

function badgeFor(account, status) {
  if (!account.enabled) return { cls: 'off', text: '已停用' }
  if (!status) return { cls: 'pending', text: statusText('pending') }
  if (status === 'failed') return { cls: 'failed', text: statusText('failed') }
  return { cls: status, text: statusText(status) }
}

function renderCards() {
  const grid = $('site-grid')
  grid.innerHTML = ''

  if (!current.accounts.length) {
    const empty = document.createElement('article')
    empty.className = 'site-card empty-card'
    empty.innerHTML = `<div class="site-top"><div class="site-avatar">+</div><div class="site-id"><strong>还没有 AI 账号</strong><small>点击上方「添加账号」填写站点、用户名和密码</small></div></div>`
    grid.appendChild(empty)
    return
  }

  for (const account of current.accounts) {
    const entry = historyEntry(account.id)
    const status = todayStatus(account.id)
    const streak = streakOf(entry.dates)
    const total = entry.total || entry.dates.length
    const badge = badgeFor(account, status)
    const initial = (account.name || 'AI').trim().charAt(0).toUpperCase() || 'AI'

    const card = document.createElement('article')
    card.className = 'site-card' + (account.enabled ? '' : ' is-off')
    card.dataset.accountId = account.id
    card.innerHTML = `
      <div class="site-top">
        <div class="site-avatar">${escapeHtml(initial)}</div>
        <div class="site-id">
          <strong title="${escapeHtml(account.name)}">${escapeHtml(account.name)}</strong>
          <small>${escapeHtml(hostOf(account.base_url))} · ${escapeHtml(account.username)}</small>
        </div>
        <span class="badge ${escapeHtml(badge.cls)}">${escapeHtml(badge.text)}</span>
      </div>
      <div class="site-meta">
        <div><small>连续</small><strong class="flame">${streak} 天</strong></div>
        <div><small>累计</small><strong>${total}</strong></div>
        <div><small>最近</small><strong style="font-size:12px">${fmtTime(entry.lastAt)}</strong></div>
      </div>
      <div class="site-actions">
        <button class="btn btn-primary" type="button" data-action="sign" data-id="${escapeHtml(account.id)}" ${account.enabled ? '' : 'disabled'}>签到</button>
        <button class="btn btn-secondary" type="button" data-action="edit" data-id="${escapeHtml(account.id)}">编辑</button>
        <button class="btn btn-danger" type="button" data-action="remove" data-id="${escapeHtml(account.id)}">删除</button>
      </div>`
    grid.appendChild(card)
  }
}

function renderDashboard() {
  const today = dayKey()
  const enabled = current.accounts.filter(account => account.enabled)
  const doneAccounts = enabled.filter(account => ['success', 'already'].includes(todayStatus(account.id)))
  const percent = enabled.length ? Math.round(doneAccounts.length / enabled.length * 100) : 0

  const allDates = current.accounts.flatMap(account => historyEntry(account.id).dates || [])
  const monthPrefix = today.slice(0, 7)
  const monthCount = allDates.filter(date => date.startsWith(monthPrefix)).length
  const totalSignins = current.accounts.reduce((sum, account) => sum + (historyEntry(account.id).total || historyEntry(account.id).dates?.length || 0), 0)
  const longestStreak = current.accounts.reduce((max, account) => Math.max(max, streakOf(historyEntry(account.id).dates || [])), 0)

  $('hero-done').textContent = String(doneAccounts.length)
  $('hero-total').textContent = String(enabled.length)
  $('chip-enabled').textContent = String(enabled.length)
  $('chip-sign-time').textContent = current.sign_time || DEFAULT_SIGN_TIME
  $('ring-percent').textContent = `${percent}%`
  $('ring-value').style.strokeDasharray = String(CIRC)
  $('ring-value').style.strokeDashoffset = String(CIRC * (1 - percent / 100))

  $('stat-sites').textContent = String(current.accounts.length)
  $('stat-total').textContent = String(totalSignins)
  $('stat-streak').innerHTML = `${longestStreak}<small> 天</small>`
  $('stat-month').textContent = String(monthCount)
  $('sites-count').textContent = String(current.accounts.length)

  if (!current.accounts.length) {
    $('hero-sub').textContent = '请先添加 AI 账号，保存后每天到点自动完成签到。'
  } else if (!enabled.length) {
    $('hero-sub').textContent = '当前账号均已停用，启用后才会执行签到。'
  } else if (doneAccounts.length === enabled.length) {
    $('hero-sub').textContent = `今日签到已完成，明天 ${current.sign_time || DEFAULT_SIGN_TIME} 会继续自动打卡。`
  } else if (doneAccounts.length > 0) {
    $('hero-sub').textContent = `已有 ${doneAccounts.length} 个账号完成签到，还有 ${enabled.length - doneAccounts.length} 个待处理。`
  } else {
    $('hero-sub').textContent = '账号已配置，点击「立即签到」完成今日打卡。'
  }

  renderCards()
  renderHeatmap()
  renderTimeline()
}

function fillGlobalForm() {
  $('cfg-notify-success').checked = current.notify_success !== false
  $('cfg-notify-failure').checked = current.notify_failure !== false
  $('cfg-sign-time').value = current.sign_time || DEFAULT_SIGN_TIME
}

async function migrateHistory() {
  const today = dayKey()
  let changed = false

  for (const account of current.accounts) {
    const site = siteFor(account.id)
    const status = site?.outcome || lastResult?.outcome || ''
    const signedToday = ['success', 'already'].includes(status) && lastResult?.at && dayKey(lastResult.at) === today
    if (!signedToday) continue

    const entry = historyEntry(account.id)
    entry.lastStatus = status
    entry.lastDetail = site?.message || lastResult?.message || ''
    entry.lastAt = lastResult.at ? new Date(lastResult.at).getTime() : entry.lastAt || Date.now()
    if (!Array.isArray(entry.dates)) entry.dates = []
    if (!entry.dates.includes(today)) entry.dates.push(today)
    entry.total = entry.dates.length
    history[account.id] = entry
    changed = true
  }

  if (changed) await ctxRef.storage.set(HISTORY_KEY, history)
}

async function load() {
  const [settings, last, rawHistory] = await Promise.all([
    ctxRef.settings.get().catch(() => ({})),
    ctxRef.storage.get('last_result').catch(() => null),
    ctxRef.storage.get(HISTORY_KEY).catch(() => ({}))
  ])
  const unwrappedSettings = unwrapStorageValue(settings) || {}
  const unwrappedHistory = unwrapStorageValue(rawHistory) || {}
  current = migrateSettings(unwrappedSettings)
  lastResult = unwrapStorageValue(last) || null
  history = unwrappedHistory && typeof unwrappedHistory === 'object' && !Array.isArray(unwrappedHistory) ? unwrappedHistory : {}
  await migrateHistory()
  fillGlobalForm()
  renderDashboard()
}

async function persistSettings(showToast = false) {
  await ctxRef.settings.set(current)
  if (showToast) toast('账号与通知设置已保存', 'ok')
}

function openModal(id = null) {
  editingId = id
  const account = id ? getAccount(id) : null
  $('modal-title').textContent = account ? '编辑 AI 账号' : '添加 AI 账号'
  $('m-name').value = account?.name || ''
  $('m-base-url').value = account?.base_url || ''
  $('m-username').value = account?.username || ''
  $('m-password').value = ''
  $('m-enabled').checked = account ? account.enabled : true
  $('account-modal').hidden = false
  setTimeout(() => $('m-name')?.focus(), 30)
}

function closeModal() {
  $('account-modal').hidden = true
  editingId = null
}

async function saveModalAccount() {
  const name = $('m-name').value.trim()
  const username = $('m-username').value.trim()
  const password = $('m-password').value
  const enabled = $('m-enabled').checked

  let baseUrl
  if (!$('m-base-url').value.trim()) {
    toast('请填写站点地址', 'err')
    return
  }
  try {
    baseUrl = normalizeUrl($('m-base-url').value)
  } catch {
    toast('站点地址格式不正确', 'err')
    return
  }

  if (!username) { toast('请填写用户名或邮箱', 'err'); return }
  const existing = editingId ? getAccount(editingId) : null
  if (!existing && !password) { toast('新账号请填写密码', 'err'); return }

  if (existing) {
    existing.name = name || username
    existing.base_url = baseUrl
    existing.username = username
    existing.password = password || existing.password
    existing.enabled = enabled
  } else {
    current.accounts.push({
      id: uid(),
      name: name || username,
      base_url: baseUrl,
      username,
      password,
      enabled,
      createdAt: Date.now()
    })
  }

  await persistSettings()
  closeModal()
  await load()
  toast(existing ? '账号已更新' : '账号已添加', 'ok')
}

async function removeAccount(id) {
  const account = getAccount(id)
  if (!account) return
  if (!window.confirm(`确定删除账号「${account.name}」吗？签到历史会保留在本机插件记录中。`)) return
  current.accounts = current.accounts.filter(item => item.id !== id)
  await persistSettings()
  await load()
  toast('账号已删除', 'info')
}

function waitRun(runId) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    clearInterval(pollTimer)
    pollTimer = setInterval(async () => {
      if (ctxRef.signal?.aborted) {
        clearInterval(pollTimer)
        reject(new Error('页面已取消'))
        return
      }
      attempts++
      try {
        const run = await ctxRef.tasks.get(runId)
        const status = String(run?.status || '').toLowerCase()
        if (['success', 'succeeded', 'completed', 'done', 'failed', 'error', 'cancelled', 'canceled'].includes(status)) {
          clearInterval(pollTimer)
          if (['failed', 'error', 'cancelled', 'canceled'].includes(status) && run?.error) {
            toast(String(run.error?.message || run.error).slice(0, 120), 'err')
          }
          resolve(run)
        } else if (attempts > 120) {
          clearInterval(pollTimer)
          resolve(run)
        }
      } catch (error) {
        if (attempts > 120) {
          clearInterval(pollTimer)
          reject(error)
        }
      }
    }, 700)
  })
}

function setButtonsDisabled(disabled) {
  for (const id of ['sign-now', 'open-add-account', 'modal-save']) {
    const btn = $(id)
    if (btn) btn.disabled = disabled
  }
  document.querySelectorAll('[data-action="sign"]').forEach(btn => { btn.disabled = disabled })
}

async function handleRun(accountId = null) {
  if (running) return
  if (!ctxRef.tasks || typeof ctxRef.tasks.run !== 'function') {
    toast('当前宿主版本不支持从页面提交后台任务', 'err')
    return
  }

  const target = accountId ? getAccount(accountId) : null
  if (accountId && !target) {
    toast('指定账号不存在，请刷新页面', 'err')
    return
  }
  if (!current.accounts.length) {
    toast('请先添加 AI 账号', 'err')
    return
  }
  if (!target && !current.accounts.some(account => account.enabled)) {
    toast('请先启用至少一个 AI 账号', 'err')
    return
  }
  if (target && !target.base_url) {
    toast('请先填写该账号的站点地址', 'err')
    return
  }
  if (!target && !current.accounts.some(account => account.enabled && account.base_url)) {
    toast('请先填写启用账号的站点地址', 'err')
    return
  }

  try {
    running = true
    setButtonsDisabled(true)
    toast(target ? `正在提交「${target.name}」签到任务…` : '正在提交全部账号签到任务…', 'info')
    await persistSettings()

    const key = `page-manual-${Date.now()}`
    const input = { source: 'page' }
    if (accountId) input.accountId = accountId
    const started = await ctxRef.tasks.run('daily-signin', key, input)
    const runId = started?.id || started?.run_id || started
    const run = await waitRun(runId)
    await load()

    if (run?.status === 'failed' || run?.status === 'error') {
      toast('签到任务未成功完成，请查看最近记录', 'err')
    } else {
      toast('签到任务已完成，结果已刷新', 'ok')
    }
  } catch (error) {
    toast('提交签到任务失败：' + (error?.message || error), 'err')
  } finally {
    running = false
    setButtonsDisabled(false)
  }
}

async function handleNotifyTest() {
  const btn = $('notify-test')
  btn.disabled = true
  try {
    const res = await sendNotification({
      title: 'AI 签到助手 · 测试通知',
      body: '**AI 签到助手**\n这是一条测试通知。\n收到就说明通知链路通畅。',
      format: 'markdown',
      level: 'info',
      dedupe_key: `ai-signin:test:${Date.now()}`
    })
    describeNotify(res, '测试通知')
  } catch (error) {
    toast('测试通知失败：' + (error?.message || error), 'err')
  } finally {
    btn.disabled = false
  }
}

async function handleChannels() {
  try {
    if (!ctxRef.notifications?.channels) {
      $('notify-hint').textContent = '当前宿主未提供通知渠道查询接口。'
      return
    }
    const list = await ctxRef.notifications.channels()
    const rows = (Array.isArray(list) ? list : []).map(channel =>
      `${channel.name || channel.channel}：${channel.deliverable ? '可发送' : ({ not_configured: '未配置', disabled: '已禁用', quiet_hours: '静默时段' }[channel.reason] || '不可用')}`
    )
    $('notify-hint').textContent = rows.length ? '通知渠道 → ' + rows.join('；') : '宿主未配置任何通知渠道'
  } catch (error) {
    toast('读取通知渠道失败：' + (error?.message || error), 'err')
  }
}

export function mount(ctx) {
  ctxRef = ctx

  renderClock()
  clockTimer = setInterval(renderClock, 30000)

  on($('refresh'), 'click', () => { void load(); toast('数据已刷新', 'info') })
  on($('sign-now'), 'click', () => void handleRun())
  on($('open-add-account'), 'click', () => openModal())
  on($('modal-close'), 'click', closeModal)
  on($('modal-cancel'), 'click', closeModal)
  on($('modal-save'), 'click', () => void saveModalAccount())
  on($('account-modal'), 'click', event => {
    if (event.target === $('account-modal')) closeModal()
  })

  const grid = $('site-grid')
  on(grid, 'click', event => {
    const button = event.target.closest('[data-action]')
    if (!button) return
    const { action, id } = button.dataset
    if (action === 'sign') void handleRun(id)
    if (action === 'edit') openModal(id)
    if (action === 'remove') void removeAccount(id)
  })

  on($('cfg-notify-success'), 'change', async event => {
    current.notify_success = event.target.checked
    await persistSettings()
  })
  on($('cfg-notify-failure'), 'change', async event => {
    current.notify_failure = event.target.checked
    await persistSettings()
  })
  on($('cfg-sign-time'), 'change', async event => {
    const next = normalizeTime(event.target.value)
    event.target.value = next
    current.sign_time = next
    await persistSettings()
    renderDashboard()
    toast(`每日签到时间已设为 ${next}`, 'ok')
  })

  on($('notify-test'), 'click', () => void handleNotifyTest())
  on($('notify-channels'), 'click', () => void handleChannels())

  let disposed = false
  function dispose() {
    if (disposed) return
    disposed = true
    running = false
    clearInterval(clockTimer)
    clearInterval(pollTimer)
    ctx.signal?.removeEventListener('abort', dispose)
    disposers.forEach(fn => fn())
    disposers = []
  }

  if (ctx.signal) {
    ctx.signal.addEventListener('abort', dispose)
    if (ctx.signal.aborted) dispose()
  }

  void load()
  return dispose
}

let started = false
function start(event) {
  const ctx = event?.detail || window.DIAN115Plugin
  if (!started && ctx) {
    started = true
    mount(ctx)
  }
}

window.addEventListener('dian115:ready', start, { once: true })
start()
