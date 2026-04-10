import { createHash } from 'node:crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { setupTestDb } from '../__tests__/helpers/testDb.js'
import { buildApp } from '../__tests__/helpers/buildApp.js'
import {
  createFeed,
  createCategory,
  insertArticle,
  markArticleBookmarked,
  markArticleSeen,
} from '../db.js'
import { getDb } from '../db/connection.js'
import { hashSync } from 'bcryptjs'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance

const FEVER_URL = '/fever/'

function md5(str: string): string {
  return createHash('md5').update(str).digest('hex')
}

function seedUser(email = 'fever@example.com', password = 'password123') {
  const db = getDb()
  const hash = hashSync(password, 4)
  db.prepare('INSERT OR IGNORE INTO users (email, password_hash) VALUES (?, ?)').run(email, hash)
  return { email, password }
}

function setFeverCredentials(email: string, password: string) {
  const hash = md5(`${email}:${password}`)
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('fever.api_key_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(hash)
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('fever.username', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(email)
  return hash
}

const form = { 'content-type': 'application/x-www-form-urlencoded' }

function feverPost(app: FastifyInstance, query: string, apiKey: string) {
  return app.inject({
    method: 'POST',
    url: `${FEVER_URL}?${query}`,
    headers: form,
    payload: `api_key=${apiKey}`,
  })
}

function seedFeedWithCategory() {
  const cat = createCategory('Tech')
  const feed = createFeed({
    name: 'Test Feed',
    url: 'https://example.com/feed',
    category_id: cat.id,
  })
  return { cat, feed }
}

function seedArticle(feedId: number, overrides: Record<string, unknown> = {}) {
  const id = insertArticle({
    feed_id: feedId,
    title: 'Test Article',
    url: `https://example.com/article/${Math.random()}`,
    published_at: null,
    ...(overrides as Parameters<typeof insertArticle>[0]),
  })
  return { id }
}

beforeEach(async () => {
  setupTestDb()
  app = await buildApp()
})

describe('Fever API — authentication', () => {
  it('returns auth=0 when no credentials are configured', async () => {
    const res = await feverPost(app, 'api', md5('user:pass'))
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.auth).toBe(0)
    expect(body.api_version).toBe(3)
  })

  it('returns auth=0 for wrong api_key', async () => {
    seedUser()
    setFeverCredentials('fever@example.com', 'secret')
    const res = await feverPost(app, 'api', md5('fever@example.com:wrong'))
    expect(res.statusCode).toBe(200)
    expect(res.json().auth).toBe(0)
  })

  it('returns auth=1 for correct api_key', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const res = await feverPost(app, 'api', apiKey)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.auth).toBe(1)
    expect(body.api_version).toBe(3)
    expect(typeof body.last_refreshed_on_time).toBe('number')
  })

  it('returns auth=1 when api_key is passed in query string', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const res = await app.inject({
      method: 'POST',
      url: `${FEVER_URL}?api&api_key=${apiKey}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().auth).toBe(1)
  })
})

describe('Fever API — feeds', () => {
  it('returns feeds list', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    seedFeedWithCategory()

    const res = await feverPost(app, 'feeds', apiKey)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.auth).toBe(1)
    expect(Array.isArray(body.feeds)).toBe(true)
    expect(body.feeds).toHaveLength(1)
    const feed = body.feeds[0]
    expect(feed).toHaveProperty('id')
    expect(feed).toHaveProperty('title')
    expect(feed).toHaveProperty('url')
    expect(feed).toHaveProperty('site_url')
    expect(feed).toHaveProperty('favicon_id', 0)
    expect(feed).toHaveProperty('is_spark', 0)
    expect(Array.isArray(body.feeds_groups)).toBe(true)
  })
})

describe('Fever API — groups', () => {
  it('returns groups (categories) list', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { cat } = seedFeedWithCategory()

    const res = await feverPost(app, 'groups', apiKey)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.auth).toBe(1)
    expect(Array.isArray(body.groups)).toBe(true)
    expect(body.groups).toHaveLength(1)
    expect(body.groups[0]).toEqual({ id: cat.id, title: 'Tech' })
    expect(Array.isArray(body.feeds_groups)).toBe(true)
  })

  it('includes feed→group mapping', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { cat, feed } = seedFeedWithCategory()

    const res = await feverPost(app, 'groups', apiKey)
    const body = res.json()
    const mapping = body.feeds_groups.find((fg: { group_id: number }) => fg.group_id === cat.id)
    expect(mapping).toBeDefined()
    expect(mapping.feed_ids).toContain(String(feed.id))
  })
})

describe('Fever API — items', () => {
  it('returns items list', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    seedArticle(feed.id, { title: 'Article 1', url: 'https://example.com/a1' })
    seedArticle(feed.id, { title: 'Article 2', url: 'https://example.com/a2' })

    const res = await feverPost(app, 'items', apiKey)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.auth).toBe(1)
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.items).toHaveLength(2)
    expect(body.total_items).toBe(2)
    const item = body.items[0]
    expect(item).toHaveProperty('id')
    expect(item).toHaveProperty('feed_id', feed.id)
    expect(item).toHaveProperty('title')
    expect(item).toHaveProperty('url')
    expect(item).toHaveProperty('html')
    expect(item).toHaveProperty('is_read')
    expect(item).toHaveProperty('is_saved')
    expect(item).toHaveProperty('created_on_time')
  })

  it('returns items since_id', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    const a1 = seedArticle(feed.id, { url: 'https://example.com/a1' })
    seedArticle(feed.id, { url: 'https://example.com/a2' })
    seedArticle(feed.id, { url: 'https://example.com/a3' })

    const res = await feverPost(app, `items&since_id=${a1.id}`, apiKey)
    const body = res.json()
    expect(body.items).toHaveLength(2)
    expect(body.items.every((i: { id: number }) => i.id > a1.id)).toBe(true)
  })

  it('returns items with_ids', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    const a1 = seedArticle(feed.id, { url: 'https://example.com/a1' })
    seedArticle(feed.id, { url: 'https://example.com/a2' })
    const a3 = seedArticle(feed.id, { url: 'https://example.com/a3' })

    const res = await feverPost(app, `items&with_ids=${a1.id},${a3.id}`, apiKey)
    const body = res.json()
    expect(body.items).toHaveLength(2)
    const ids = body.items.map((i: { id: number }) => i.id)
    expect(ids).toContain(a1.id)
    expect(ids).toContain(a3.id)
  })

  it('returns items max_id', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    seedArticle(feed.id, { url: 'https://example.com/a1' })
    seedArticle(feed.id, { url: 'https://example.com/a2' })
    const a3 = seedArticle(feed.id, { url: 'https://example.com/a3' })

    const res = await feverPost(app, `items&max_id=${a3.id}`, apiKey)
    const body = res.json()
    expect(body.items.every((i: { id: number }) => i.id < a3.id)).toBe(true)
  })

  it('reflects is_read and is_saved state', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    const a1 = seedArticle(feed.id, { url: 'https://example.com/a1' })
    const a2 = seedArticle(feed.id, { url: 'https://example.com/a2' })
    markArticleSeen(a1.id, true)
    markArticleBookmarked(a2.id, true)

    const res = await feverPost(app, 'items', apiKey)
    const body = res.json()
    const item1 = body.items.find((i: { id: number }) => i.id === a1.id)
    const item2 = body.items.find((i: { id: number }) => i.id === a2.id)
    expect(item1.is_read).toBe(1)
    expect(item2.is_saved).toBe(1)
  })
})

describe('Fever API — unread/saved IDs', () => {
  it('returns unread_item_ids', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    const a1 = seedArticle(feed.id, { url: 'https://example.com/a1' })
    const a2 = seedArticle(feed.id, { url: 'https://example.com/a2' })
    markArticleSeen(a1.id, true) // mark a1 as read

    const res = await feverPost(app, 'unread_item_ids', apiKey)
    const body = res.json()
    expect(body).toHaveProperty('unread_item_ids')
    const ids = body.unread_item_ids.split(',').map(Number).filter(Boolean)
    expect(ids).toContain(a2.id)
    expect(ids).not.toContain(a1.id)
  })

  it('returns empty unread_item_ids when all read', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    const a1 = seedArticle(feed.id, { url: 'https://example.com/a1' })
    markArticleSeen(a1.id, true)

    const res = await feverPost(app, 'unread_item_ids', apiKey)
    const body = res.json()
    expect(body.unread_item_ids).toBe('')
  })

  it('returns saved_item_ids for bookmarked articles', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    const a1 = seedArticle(feed.id, { url: 'https://example.com/a1' })
    const a2 = seedArticle(feed.id, { url: 'https://example.com/a2' })
    markArticleBookmarked(a1.id, true)

    const res = await feverPost(app, 'saved_item_ids', apiKey)
    const body = res.json()
    expect(body).toHaveProperty('saved_item_ids')
    const ids = body.saved_item_ids.split(',').map(Number).filter(Boolean)
    expect(ids).toContain(a1.id)
    expect(ids).not.toContain(a2.id)
  })
})

describe('Fever API — mark operations', () => {
  it('marks item as read', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    const article = seedArticle(feed.id, { url: 'https://example.com/a1' })

    const res = await feverPost(app, `mark=item&as=read&id=${article.id}`, apiKey)
    expect(res.statusCode).toBe(200)
    expect(res.json().auth).toBe(1)

    // Verify in items that it's now read
    const itemsRes = await feverPost(app, 'items', apiKey)
    const item = itemsRes.json().items.find((i: { id: number }) => i.id === article.id)
    expect(item.is_read).toBe(1)
  })

  it('marks item as unread', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    const article = seedArticle(feed.id, { url: 'https://example.com/a1' })
    markArticleSeen(article.id, true)

    await feverPost(app, `mark=item&as=unread&id=${article.id}`, apiKey)

    const itemsRes = await feverPost(app, 'items', apiKey)
    const item = itemsRes.json().items.find((i: { id: number }) => i.id === article.id)
    expect(item.is_read).toBe(0)
  })

  it('marks item as saved (bookmarked)', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    const article = seedArticle(feed.id, { url: 'https://example.com/a1' })

    await feverPost(app, `mark=item&as=saved&id=${article.id}`, apiKey)

    const itemsRes = await feverPost(app, 'items', apiKey)
    const item = itemsRes.json().items.find((i: { id: number }) => i.id === article.id)
    expect(item.is_saved).toBe(1)
  })

  it('marks item as unsaved', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    const article = seedArticle(feed.id, { url: 'https://example.com/a1' })
    markArticleBookmarked(article.id, true)

    await feverPost(app, `mark=item&as=unsaved&id=${article.id}`, apiKey)

    const itemsRes = await feverPost(app, 'items', apiKey)
    const item = itemsRes.json().items.find((i: { id: number }) => i.id === article.id)
    expect(item.is_saved).toBe(0)
  })

  it('marks feed as read', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    seedArticle(feed.id, { url: 'https://example.com/a1' })
    seedArticle(feed.id, { url: 'https://example.com/a2' })

    await feverPost(app, `mark=feed&as=read&id=${feed.id}`, apiKey)

    const res = await feverPost(app, 'unread_item_ids', apiKey)
    expect(res.json().unread_item_ids).toBe('')
  })

  it('marks feed as read before timestamp', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { feed } = seedFeedWithCategory()
    const beforeTs = Math.floor(Date.now() / 1000) - 100
    const afterTs = Math.floor(Date.now() / 1000) + 3600
    const a1 = seedArticle(feed.id, {
      url: 'https://example.com/a1',
      published_at: new Date((beforeTs - 10) * 1000).toISOString(),
    })
    const a2 = seedArticle(feed.id, {
      url: 'https://example.com/a2',
      published_at: new Date(afterTs * 1000).toISOString(),
    })

    await feverPost(app, `mark=feed&as=read&id=${feed.id}&before=${beforeTs + 5}`, apiKey)

    const res = await feverPost(app, 'unread_item_ids', apiKey)
    const ids = res.json().unread_item_ids.split(',').map(Number).filter(Boolean)
    expect(ids).not.toContain(a1.id)
    expect(ids).toContain(a2.id)
  })

  it('marks group as read', async () => {
    seedUser()
    const apiKey = setFeverCredentials('fever@example.com', 'secret')
    const { cat, feed } = seedFeedWithCategory()
    seedArticle(feed.id, { url: 'https://example.com/a1' })
    seedArticle(feed.id, { url: 'https://example.com/a2' })

    await feverPost(app, `mark=group&as=read&id=${cat.id}`, apiKey)

    const res = await feverPost(app, 'unread_item_ids', apiKey)
    expect(res.json().unread_item_ids).toBe('')
  })
})

describe('Fever API — settings management', () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = '1'
  })

  it('GET /api/settings/fever returns not configured by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/fever' })
    expect(res.statusCode).toBe(200)
    expect(res.json().configured).toBe(false)
    expect(res.json().username).toBeNull()
  })

  it('POST /api/settings/fever sets credentials', async () => {
    seedUser('fever@example.com', 'pass123')
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/fever',
      headers: { 'content-type': 'application/json' },
      payload: { password: 'myFeverPass' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.configured).toBe(true)
    expect(body.username).toBe('fever@example.com')
  })

  it('POST /api/settings/fever rejects empty password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/fever',
      headers: { 'content-type': 'application/json' },
      payload: { password: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('DELETE /api/settings/fever removes credentials', async () => {
    seedUser('fever@example.com', 'pass123')
    await app.inject({
      method: 'POST',
      url: '/api/settings/fever',
      headers: { 'content-type': 'application/json' },
      payload: { password: 'myFeverPass' },
    })

    const del = await app.inject({ method: 'DELETE', url: '/api/settings/fever' })
    expect(del.statusCode).toBe(200)
    expect(del.json().ok).toBe(true)

    const status = await app.inject({ method: 'GET', url: '/api/settings/fever' })
    expect(status.json().configured).toBe(false)
  })

  it('Fever auth works after setting credentials via API', async () => {
    seedUser('fever@example.com', 'pass123')
    await app.inject({
      method: 'POST',
      url: '/api/settings/fever',
      headers: { 'content-type': 'application/json' },
      payload: { password: 'myFeverPass' },
    })

    delete process.env.AUTH_DISABLED
    const apiKey = md5('fever@example.com:myFeverPass')
    const res = await feverPost(app, 'api', apiKey)
    expect(res.json().auth).toBe(1)
  })
})
