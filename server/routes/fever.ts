import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { getDb } from '../db.js'
import { getSetting } from '../db/settings.js'
import { getFeeds, getCategories, markArticleSeen, markArticleBookmarked, markAllSeenByFeed, markAllSeenByCategory } from '../db.js'
import { syncArticleFiltersToSearch } from '../search/sync.js'

const FEVER_API_VERSION = 3
const ITEMS_PER_PAGE = 50

function md5(str: string): string {
  return createHash('md5').update(str).digest('hex')
}

export function setFeverCredentials(password: string): void {
  const username = getFeverUsername()
  if (!username) return
  const hash = md5(`${username}:${password}`)
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('fever.api_key_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hash)
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('fever.username', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(username)
}

export function removeFeverCredentials(): void {
  getDb().prepare("DELETE FROM settings WHERE key IN ('fever.api_key_hash', 'fever.username')").run()
}

export function getFeverStatus(): { configured: boolean; username: string | null } {
  const hash = getSetting('fever.api_key_hash')
  const username = getSetting('fever.username')
  return { configured: !!hash, username: username ?? null }
}

function getFeverUsername(): string | null {
  const row = getDb().prepare('SELECT email FROM users LIMIT 1').get() as { email: string } | undefined
  return row?.email ?? null
}

function verifyFeverAuth(apiKey: string): boolean {
  const stored = getSetting('fever.api_key_hash')
  if (!stored) return false
  return stored === apiKey
}

function baseResponse(auth: 0 | 1): Record<string, unknown> {
  return {
    api_version: FEVER_API_VERSION,
    auth,
    last_refreshed_on_time: Math.floor(Date.now() / 1000),
  }
}

// --- Feed shape ---
function getFeverFeeds() {
  const feeds = getFeeds()
  return feeds.map((f) => {
    // Derive site_url from feed URL (strip common feed path suffixes)
    let siteUrl = f.url
    try {
      const u = new URL(f.url)
      siteUrl = `${u.protocol}//${u.host}`
    } catch {
      // keep as-is
    }
    return {
      id: f.id,
      favicon_id: 0,
      title: f.name,
      url: f.rss_url ?? f.url,
      site_url: siteUrl,
      is_spark: 0,
      last_updated_on_time: 0,
    }
  })
}

// --- Group (category) shape ---
function getFeverGroups() {
  const cats = getCategories()
  return cats.map((c) => ({ id: c.id, title: c.name }))
}

// --- Feed groups mapping ---
function getFeedGroups() {
  const feeds = getFeeds()
  const byCategory: Record<number, number[]> = {}
  for (const f of feeds) {
    if (f.category_id) {
      if (!byCategory[f.category_id]) byCategory[f.category_id] = []
      byCategory[f.category_id].push(f.id)
    }
  }
  return Object.entries(byCategory).map(([groupId, feedIds]) => ({
    group_id: Number(groupId),
    feed_ids: feedIds.join(','),
  }))
}

// --- Item shape ---
interface FeverItem {
  id: number
  feed_id: number
  title: string
  author: string
  html: string
  url: string
  is_read: number
  is_saved: number
  created_on_time: number
}

interface RawArticleRow {
  id: number
  feed_id: number
  title: string
  url: string
  full_text: string | null
  excerpt: string | null
  seen_at: string | null
  bookmarked_at: string | null
  liked_at: string | null
  published_at: string | null
  fetched_at: string
}

function toFeverItem(row: RawArticleRow): FeverItem {
  const ts = row.published_at ?? row.fetched_at
  return {
    id: row.id,
    feed_id: row.feed_id,
    title: row.title,
    author: '',
    html: row.full_text ?? row.excerpt ?? '',
    url: row.url,
    is_read: row.seen_at ? 1 : 0,
    is_saved: row.bookmarked_at || row.liked_at ? 1 : 0,
    created_on_time: ts ? Math.floor(new Date(ts).getTime() / 1000) : 0,
  }
}

const ITEM_SELECT = `
  a.id, a.feed_id, a.title, a.url,
  a.full_text, a.excerpt,
  a.seen_at, a.bookmarked_at, a.liked_at,
  a.published_at, a.fetched_at
`

function getFeverItems(opts: {
  sinceId?: number
  maxId?: number
  withIds?: number[]
}): FeverItem[] {
  const db = getDb()

  if (opts.withIds && opts.withIds.length > 0) {
    const ids = opts.withIds.slice(0, ITEMS_PER_PAGE)
    const placeholders = ids.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT ${ITEM_SELECT} FROM active_articles a WHERE a.id IN (${placeholders}) ORDER BY a.id ASC`)
      .all(...ids) as RawArticleRow[]
    return rows.map(toFeverItem)
  }

  if (opts.sinceId !== undefined) {
    const rows = db
      .prepare(`SELECT ${ITEM_SELECT} FROM active_articles a WHERE a.id > ? ORDER BY a.id ASC LIMIT ${ITEMS_PER_PAGE}`)
      .all(opts.sinceId) as RawArticleRow[]
    return rows.map(toFeverItem)
  }

  if (opts.maxId !== undefined) {
    const rows = db
      .prepare(`SELECT ${ITEM_SELECT} FROM active_articles a WHERE a.id < ? ORDER BY a.id DESC LIMIT ${ITEMS_PER_PAGE}`)
      .all(opts.maxId) as RawArticleRow[]
    return rows.reverse().map(toFeverItem)
  }

  // Default: latest items
  const rows = db
    .prepare(`SELECT ${ITEM_SELECT} FROM active_articles a ORDER BY a.id DESC LIMIT ${ITEMS_PER_PAGE}`)
    .all() as RawArticleRow[]
  return rows.reverse().map(toFeverItem)
}

function getTotalItemsCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS cnt FROM active_articles').get() as { cnt: number }
  return row.cnt
}

function getUnreadItemIds(): string {
  const rows = getDb()
    .prepare('SELECT id FROM active_articles WHERE seen_at IS NULL ORDER BY id ASC')
    .all() as { id: number }[]
  return rows.map((r) => r.id).join(',')
}

function getSavedItemIds(): string {
  const rows = getDb()
    .prepare('SELECT id FROM active_articles WHERE bookmarked_at IS NOT NULL OR liked_at IS NOT NULL ORDER BY id ASC')
    .all() as { id: number }[]
  return rows.map((r) => r.id).join(',')
}

function markFeedBeforeTimestamp(feedId: number, beforeUnix: number): void {
  const beforeIso = new Date(beforeUnix * 1000).toISOString()
  const affectedIds = (getDb()
    .prepare(
      `SELECT id FROM active_articles
       WHERE feed_id = ? AND seen_at IS NULL
       AND COALESCE(published_at, fetched_at) <= ?`,
    )
    .all(feedId, beforeIso) as { id: number }[]).map((r) => r.id)

  if (affectedIds.length > 0) {
    const placeholders = affectedIds.map(() => '?').join(',')
    getDb()
      .prepare(`UPDATE articles SET seen_at = datetime('now') WHERE id IN (${placeholders})`)
      .run(...affectedIds)
    syncArticleFiltersToSearch(affectedIds.map((id) => ({ id, is_unread: false })))
  }
}

function markGroupBeforeTimestamp(categoryId: number, beforeUnix: number): void {
  const beforeIso = new Date(beforeUnix * 1000).toISOString()
  const affectedIds = (getDb()
    .prepare(
      `SELECT id FROM active_articles
       WHERE category_id = ? AND seen_at IS NULL
       AND COALESCE(published_at, fetched_at) <= ?`,
    )
    .all(categoryId, beforeIso) as { id: number }[]).map((r) => r.id)

  if (affectedIds.length > 0) {
    const placeholders = affectedIds.map(() => '?').join(',')
    getDb()
      .prepare(`UPDATE articles SET seen_at = datetime('now') WHERE id IN (${placeholders})`)
      .run(...affectedIds)
    syncArticleFiltersToSearch(affectedIds.map((id) => ({ id, is_unread: false })))
  }
}

function parseFormBody(raw: string): Record<string, string> {
  const params = new URLSearchParams(raw)
  const result: Record<string, string> = {}
  params.forEach((value, key) => {
    result[key] = value
  })
  return result
}

export async function feverRoutes(app: FastifyInstance): Promise<void> {
  // Register a content-type parser for form-encoded bodies (scoped to this plugin)
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, parseFormBody(body as string))
    },
  )

  // Fever API endpoint — all requests POST to /fever/
  app.post('/fever/', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>
    const query = request.query as Record<string, string>

    const apiKey = body.api_key ?? query.api_key ?? ''

    if (!verifyFeverAuth(apiKey)) {
      reply.header('Content-Type', 'application/json')
      return reply.send({ api_version: FEVER_API_VERSION, auth: 0 })
    }

    const response: Record<string, unknown> = baseResponse(1)

    // Handle mark operations (mutation)
    if ('mark' in query) {
      const mark = query.mark
      const as = query.as ?? body.as
      const id = Number(query.id ?? body.id)
      const before = Number(query.before ?? body.before ?? '0')

      if (!isNaN(id) && id > 0) {
        if (mark === 'item') {
          if (as === 'read') markArticleSeen(id, true)
          else if (as === 'unread') markArticleSeen(id, false)
          else if (as === 'saved') markArticleBookmarked(id, true)
          else if (as === 'unsaved') markArticleBookmarked(id, false)
        } else if (mark === 'feed' && as === 'read') {
          if (before > 0) {
            markFeedBeforeTimestamp(id, before)
          } else {
            markAllSeenByFeed(id)
          }
        } else if (mark === 'group' && as === 'read') {
          if (before > 0) {
            markGroupBeforeTimestamp(id, before)
          } else {
            markAllSeenByCategory(id)
          }
        }
      }
    }

    // Return requested data
    if ('feeds' in query) {
      response.feeds = getFeverFeeds()
      response.feeds_groups = getFeedGroups()
    }

    if ('groups' in query) {
      response.groups = getFeverGroups()
      response.feeds_groups = getFeedGroups()
    }

    if ('feed_groups' in query) {
      response.feeds_groups = getFeedGroups()
    }

    if ('items' in query) {
      const sinceId = query.since_id !== undefined ? Number(query.since_id) : undefined
      const maxId = query.max_id !== undefined ? Number(query.max_id) : undefined
      const withIds =
        query.with_ids
          ? query.with_ids
              .split(',')
              .map(Number)
              .filter((n) => !isNaN(n) && n > 0)
          : undefined

      response.items = getFeverItems({
        sinceId: sinceId !== undefined && !isNaN(sinceId) ? sinceId : undefined,
        maxId: maxId !== undefined && !isNaN(maxId) ? maxId : undefined,
        withIds,
      })
      response.total_items = getTotalItemsCount()
    }

    if ('unread_item_ids' in query) {
      response.unread_item_ids = getUnreadItemIds()
    }

    if ('saved_item_ids' in query) {
      response.saved_item_ids = getSavedItemIds()
    }

    reply.header('Content-Type', 'application/json')
    return reply.send(response)
  })
}
