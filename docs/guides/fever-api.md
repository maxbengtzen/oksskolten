# Fever API

Oksskolten exposes a [Fever API](https://feedafever.com/api)-compatible endpoint at `/fever/`. This lets native feed reader apps like **NetNewsWire**, **Reeder**, and others sync feeds, articles, read/unread state, and saved items directly with your Oksskolten instance.

## Setup

### 1. Create a Fever password

Go to **Settings → Security** and set a Fever API password. This is a dedicated password separate from your main login password.

The Fever API uses `md5(username:password)` as its authentication token. Your Oksskolten username (email) and this Fever password are what you'll enter in your feed reader client.

Via the API:

```bash
curl -X POST http://localhost:3000/api/settings/fever \
  -H "Authorization: Bearer ok_your_api_token" \
  -H "Content-Type: application/json" \
  -d '{"password": "your-fever-password"}'
```

Response:

```json
{
  "configured": true,
  "username": "you@example.com"
}
```

### 2. Connect your feed reader

Use the following settings in your client:

| Field | Value |
|---|---|
| **Server URL** | `https://your-oksskolten.example.com/fever/` |
| **Username** | Your Oksskolten email address |
| **Password** | The Fever password you set above |

> **Note:** The URL must end with `/fever/` (including the trailing slash).

## NetNewsWire

1. Open NetNewsWire → **Add Feed Account**
2. Choose **Fever**
3. Enter your server URL, username, and Fever password
4. NetNewsWire will authenticate and download your feeds

## Supported operations

| Feature | Supported |
|---|---|
| List feeds | ✅ |
| List feed groups (categories) | ✅ |
| List items (articles) | ✅ |
| Delta sync (`since_id`) | ✅ |
| Pagination (`max_id`) | ✅ |
| Fetch specific items (`with_ids`) | ✅ |
| Unread item IDs | ✅ |
| Saved item IDs | ✅ |
| Mark item as read/unread | ✅ |
| Mark item as saved/unsaved (bookmark) | ✅ |
| Mark feed as read | ✅ |
| Mark feed as read before timestamp | ✅ |
| Mark group as read | ✅ |
| Mark group as read before timestamp | ✅ |
| Favicons | ❌ (returns placeholder) |
| Sparks / Links | ❌ (not applicable) |

## API reference

All requests are `POST` to `/fever/`. The action is determined by query parameters. Authentication is provided via the `api_key` form field (or query parameter).

### Authentication check

```
POST /fever/?api
api_key=<md5(email:password)>
```

Response:
```json
{
  "api_version": 3,
  "auth": 1,
  "last_refreshed_on_time": 1234567890
}
```

`auth: 0` means authentication failed.

### Feeds

```
POST /fever/?feeds
```

Returns `feeds` array and `feeds_groups` mapping.

### Groups (categories)

```
POST /fever/?groups
```

Returns `groups` array and `feeds_groups` mapping.

### Items

```
POST /fever/?items
POST /fever/?items&since_id=<id>      # items with id > since_id (up to 50)
POST /fever/?items&max_id=<id>        # items with id < max_id (up to 50)
POST /fever/?items&with_ids=<id,id>   # specific items by comma-separated IDs
```

Returns `items` array and `total_items` count. Each item includes:

```json
{
  "id": 42,
  "feed_id": 3,
  "title": "Article title",
  "author": "",
  "html": "Article full text (Markdown)",
  "url": "https://example.com/article",
  "is_read": 0,
  "is_saved": 0,
  "created_on_time": 1234567890
}
```

> The `html` field contains the article's full text in Markdown format (as stored by Oksskolten). Most Fever clients display it as plain text or render it as HTML.

### Unread item IDs

```
POST /fever/?unread_item_ids
```

Returns `unread_item_ids` as a comma-separated string of IDs.

### Saved item IDs

```
POST /fever/?saved_item_ids
```

Returns `saved_item_ids` as a comma-separated string of IDs. Includes bookmarked articles.

### Mark items

```
POST /fever/?mark=item&as=read&id=<id>
POST /fever/?mark=item&as=unread&id=<id>
POST /fever/?mark=item&as=saved&id=<id>
POST /fever/?mark=item&as=unsaved&id=<id>

POST /fever/?mark=feed&as=read&id=<feed_id>
POST /fever/?mark=feed&as=read&id=<feed_id>&before=<unix_timestamp>

POST /fever/?mark=group&as=read&id=<group_id>
POST /fever/?mark=group&as=read&id=<group_id>&before=<unix_timestamp>
```

## Managing Fever credentials

### Check status

```bash
curl -H "Authorization: Bearer ok_your_api_token" \
  http://localhost:3000/api/settings/fever
```

### Set/update password

```bash
curl -X POST http://localhost:3000/api/settings/fever \
  -H "Authorization: Bearer ok_your_api_token" \
  -H "Content-Type: application/json" \
  -d '{"password": "new-fever-password"}'
```

### Revoke access

```bash
curl -X DELETE http://localhost:3000/api/settings/fever \
  -H "Authorization: Bearer ok_your_api_token"
```

After deletion, all Fever clients will receive `auth: 0` and stop syncing until new credentials are configured.
