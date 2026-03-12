# Plytix API Snapshot

Cleaned from the supplied `https://apidocs.plytix.com llms-full.txt` scrape on March 11, 2026.

This file removes scrape noise, duplicated examples, and obvious UI artifacts while preserving the API contract described in the supplied snapshot.

## Scope and normalization

- This is a cleaned snapshot of the supplied scrape, not a fresh crawl.
- When the scrape contradicted itself, this document prefers:
  1. endpoint-specific detail over generic overview text
  2. prose descriptions over malformed example requests
  3. stable request/response shapes over example status labels
- Some resource families appear only as summary tables in the supplied scrape. Those are included as inventory items and marked when details were not expanded.

## Base URLs

- Auth: `https://auth.plytix.com`
- API v1: `https://pim.plytix.com/api/v1`
- API v2 beta: `https://pim.plytix.com/api/v2`

## Authentication

- All API requests use bearer-token auth.
- Obtain a token with:
  - `POST https://auth.plytix.com/auth/api/get-token`
- Request body:

```json
{
  "api_key": "your.api.key",
  "api_password": "your.secret.api.password"
}
```

- Success response:

```json
{
  "data": [
    {
      "access_token": "..."
    }
  ]
}
```

- Token lifetime: 15 minutes.
- Use on subsequent requests:

```http
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json
```

## Global behavior

### Rate limits

- Rate limiting is plan-based.
- Limits are enforced per client/account plan.
- The scrape describes limits as:
  - requests per 10 seconds
  - requests per hour
- Exceeded limits return `429 Too Many Requests`.

### Response envelope

Successful responses are wrapped in `data`.

```json
{
  "data": []
}
```

Optional fields:

- `pagination`: present on search endpoints
- `attributes`: sometimes present when relevant to the operation

### Error envelope

Errors are wrapped in `error`.

```json
{
  "error": {
    "msg": "product data validation failed",
    "errors": [
      {
        "field": "some_field",
        "msg": "explanation"
      }
    ]
  }
}
```

### Common status codes

The scrape documents these statuses:

- `200 OK`
- `201 Created`
- `202 Accepted`
- `204 No Content`
- `400 Bad Request`
- `401 Auth Failed`
- `403 Forbidden`
- `404 Not Found`
- `405 Method Not Allowed`
- `409 Conflict`
- `422 Unprocessable Entity`
- `428 Precondition Required`
- `429 Too Many Requests`
- `500 Server Error`

### Deprecation header

- `X-Plytix-Deprecation`: returned when an endpoint is being deprecated soon.

## Search and filter model

The same basic search shape appears across assets, categories, products, memberships, API credentials, and other searchable resources.

### Filter structure

- A simple filter is one condition:

```json
{"field": "stock", "operator": "gt", "value": 10}
```

- A compound filter is an array of simple filters combined with `AND`:

```json
[
  {"field": "stock", "operator": "gt", "value": 10},
  {"field": "vendor", "operator": "like", "value": "ACME"}
]
```

- A full `filters` array is an array of compound filters combined with `OR`:

```json
[
  [
    {"field": "stock", "operator": "gt", "value": 10},
    {"field": "vendor", "operator": "like", "value": "ACME"}
  ],
  [
    {"field": "customer", "operator": "eq", "value": "Wile E. Coyote"}
  ]
]
```

### Standard operators

- `exists`
- `!exists`
- `eq`
- `!eq`
- `like`
- `in`
- `!in`
- `gt`
- `gte`
- `lt`
- `lte`
- `text_search`

Notes from the scrape:

- Text comparisons for `eq`/`!eq` ignore case.
- `Dropdown` and `MultiSelect` values are case-sensitive for `in`/`!in`.
- `text_search` takes an array of field names in `field`.

### Pagination

```json
{
  "pagination": {
    "page": 1,
    "page_size": 25,
    "order": "-sku"
  }
}
```

- `order` format: `[optional -][attribute_label]`
- default page: `1`
- default page size: `25`
- many endpoints cap `page_size` at `100`

### Attribute selection

- Search endpoints often return only a subset of fields unless `attributes` is specified.
- Product search uses attribute labels, not human-readable names.
- User product attributes must be prefixed with `attributes.`
- Relationship response columns must be prefixed with `relationships.`

### Important limit note

The scrape is inconsistent on attribute limits:

- a generic overview section says search results can return up to `20` attributes
- the later product-search sections explicitly say product searches allow up to `50` requested attributes/properties, plus `id` and `sku`

Use the endpoint-specific product-search rule for product search requests.

## Version map from the supplied scrape

### v1 resources explicitly documented in detail

- auth token
- accounts search
- assets
- filter metadata
- file categories
- product categories
- products
- nested product assets
- nested product categories
- variants
- product relationship operations
- product attributes

### v1 resources listed in summary only

- relationships root resource
- product families
- product attribute groups

### v2 beta resources explicitly documented in detail

- products
- nested product assets
- nested product categories
- variants
- product relationship operations
- family assignment

## Endpoint inventory

### Auth

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `https://auth.plytix.com/auth/api/get-token` | Exchange API key/password for bearer token |

### Accounts v1

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/accounts/memberships/search` | Search memberships |
| `POST` | `/accounts/api-credentials/search` | Search API credentials |

### Assets v1

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/assets` | Upload asset by URL or base64 content |
| `POST` | `/assets/search` | Search assets |
| `GET` | `/assets/:asset_id` | Get asset |
| `PATCH` | `/assets/:asset_id` | Rename asset or update categories |
| `DELETE` | `/assets/:asset_id` | Delete asset |
| `PUT` | `/assets/:asset_id/content` | Replace asset file content |

### Filters v1

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/filters/asset` | Asset filter definitions |
| `GET` | `/filters/product` | Product filter definitions |
| `GET` | `/filters/relationships` | Relationship filter definitions |

### File categories v1

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/categories/file` | Create root file category |
| `POST` | `/categories/file/:category_id` | Create file subcategory |
| `PATCH` | `/categories/file/:category_id` | Rename, move, or sort children |
| `PATCH` | `/categories/file/root` | Sort root file categories |
| `DELETE` | `/categories/file/:category_id` | Delete category tree |
| `POST` | `/categories/file/search` | Search file categories |

### Product categories v1

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/categories/product` | Create root product category |
| `POST` | `/categories/product/:category_id` | Create product subcategory |
| `PATCH` | `/categories/product/:category_id` | Rename, move, or sort children |
| `PATCH` | `/categories/product/root` | Sort root product categories |
| `DELETE` | `/categories/product/:category_id` | Delete category tree |
| `POST` | `/categories/product/search` | Search product categories |

### Products v1

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/products` | Create product |
| `POST` | `/products/search` | Search products |
| `GET` | `/products/:product_id` | Get product |
| `PATCH` | `/products/:product_id` | Patch product |
| `DELETE` | `/products/:product_id` | Delete product |
| `POST` | `/products/:product_id/family` | Assign or unassign family |

### Product-linked assets v1

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/products/:product_id/assets` | List linked assets |
| `POST` | `/products/:product_id/assets` | Link existing asset to thumbnail/media/media-gallery |
| `GET` | `/products/:product_id/assets/:asset_id` | Get one linked asset |
| `DELETE` | `/products/:product_id/assets/:asset_id` | Unlink asset |

### Product-linked categories v1

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/products/:product_id/categories` | List linked categories |
| `POST` | `/products/:product_id/categories` | Link existing category |
| `GET` | `/products/:product_id/categories/:category_id` | Get one linked category |
| `DELETE` | `/products/:product_id/categories/:category_id` | Unlink category |

### Variants v1

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/products/:product_id/variants` | List variants of a parent product |
| `POST` | `/products/:parent_product_id/variants` | Create a variant under parent |
| `POST` | `/products/:product_id/variant/:variant_id` | Link an existing single product as variant |
| `DELETE` | `/products/:parent_product_id/variant/:variant_id` | Unlink variant from parent |
| `POST` | `/products/:parent_product_id/variants/resync` | Reset variant values from parent for given labels |

### Product relationship operations v1

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/products/:product_id/relationships/:relationship_id` | Add or update related products |
| `POST` | `/products/:product_id/relationships/:relationship_id/unlink` | Remove related products; scrape is inconsistent here |
| `PATCH` | `/products/:product_id/relationships/:relationship_id/product/:related_product_id` | Update quantity |

### Products v2 beta

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/products` | Create product; returns id + audit metadata |
| `POST` | `/products/search` | Search products; linked media/categories are not expanded |
| `GET` | `/products/:product_id` | Get product; linked assets/categories/media are ids |
| `PATCH` | `/products/:product_id` | Patch product; returns id + audit metadata |
| `DELETE` | `/products/:product_id` | Delete product |
| `POST` | `/products/:product_id/family` | Assign or unassign family |

### Product-linked assets v2 beta

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/products/:product_id/assets` | List linked assets |
| `POST` | `/products/:product_id/assets` | Link existing asset to media attr |
| `DELETE` | `/products/:product_id/assets/:asset_id` | Unlink asset |

### Product-linked categories v2 beta

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/products/:product_id/categories` | List linked categories |
| `POST` | `/products/:product_id/categories` | Link category |
| `DELETE` | `/products/:product_id/categories/:category_id` | Unlink category |

### Variants v2 beta

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/products/:product_id/variant/:variant_id` | Link existing product as variant |
| `DELETE` | `/products/:parent_product_id/variant/:variant_id` | Unlink variant |
| `POST` | `/products/:parent_product_id/variants` | Create variant; returns new id + audit metadata |
| `POST` | `/products/:parent_product_id/variants/resync` | Resync parent-level attributes |

### Product relationship operations v2 beta

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/products/:product_id/relationships/:relationship_id` | Add related products; silently ignores bad/duplicate ids |
| `DELETE` | `/products/:product_id/relationships/:relationship_id` | Remove related products; silently ignores bad/unlinked ids |
| `PATCH` | `/products/:product_id/relationships/:relationship_id` | Update quantities; silently ignores bad/unlinked ids |

### Summary-only resources listed by the scrape

These were listed in the supplied resource summary but not expanded later in the supplied text.

#### Relationships root v1

| Method | Path |
| --- | --- |
| `POST` | `/relationships` |
| `GET` | `/relationships/:id` |
| `PATCH` | `/relationships/:id` |
| `DELETE` | `/relationships/:id` |
| `POST` | `/relationships/search` |

#### Product families v1

| Method | Path |
| --- | --- |
| `POST` | `/product_families` |
| `GET` | `/product_families/:id` |
| `PATCH` | `/product_families/:id` |
| `DELETE` | `/product_families/:id` |
| `POST` | `/product_families/search` |
| `POST` | `/product_families/:id/attributes/link` |
| `POST` | `/product_families/:id/attributes/unlink` |
| `GET` | `/product_families/:id/attributes` |
| `GET` | `/product_families/:id/all_attributes` |

## Accounts v1

### `POST /accounts/memberships/search`

Searchable fields:

- `legacy_id`
- `role` (`ADMIN`, `OWNER`, `USER`)
- `email`
- `username`
- `name`
- `last_name`

Notes:

- sorting is not supported
- if `attributes` is omitted, all fields are returned

### `POST /accounts/api-credentials/search`

Searchable fields:

- `legacy_id`
- `role` (`ADMIN`, `OWNER`, `USER`)
- `name`

Notes:

- sorting is not supported
- if `attributes` is omitted, all fields are returned

## Assets v1

### Asset fields in the scrape

- `assigned`
- `categories`
- `content_type`
- `created`
- `extension`
- `filename`
- `file_size`
- `file_type`
- `has_custom_thumb`
- `id`
- `modified`
- `n_catalogs`
- `n_products`
- `status`
- `thumbnail`
- `type`
- `url`

### Asset type groups

- `IMAGES`
- `FEED_FILES`
- `COMPRESSED`
- `REPORTS`
- `TEXTS`
- `SOUNDS`
- `VIDEOS`
- `OTHER`

### `POST /assets`

Two upload modes are documented:

1. By URL

```json
{
  "filename": "kettle_blue.jpg",
  "url": "https://public.example.com/file.jpg"
}
```

2. By base64 content

```json
{
  "filename": "kettle_red.jpg",
  "content": "<base64-bytes-only>"
}
```

Rules:

- URL must be publicly accessible.
- File type must be supported.
- If uploading by `content`, the scrape says the content must be raw base64 only; strip any `data:image/...;base64,` prefix.

### `GET /assets/:asset_id`

- Returns one asset in `data[0]`.

### `PATCH /assets/:asset_id`

Supported fields:

- `filename`
  - extension changes are not allowed
- `categories`
  - array of `{ "id": "<category_id>" }`

### `DELETE /assets/:asset_id`

- Deletes the asset.
- Success is `204 No Content`.

### `PUT /assets/:asset_id/content`

- Replaces the underlying file contents.
- Content type is `multipart/form-data`.
- Expected form field: `file`.
- The scrape shows `202 Accepted`.

### `POST /assets/search`

Notes:

- search uses the standard search DSL
- the scrape says searches return `428` if filtered results exceed `10000` assets and `pagination.order` is set

## Filters v1

These endpoints return the authoritative filter definitions for a resource.

Returned objects contain:

- `key`: request field name to use in filters
- `operators`: allowed operators
- `options`: enum-like allowed values when relevant
- `filter_type`: descriptive type

### `GET /filters/asset`

Documented characteristics:

- returns current asset filter definitions
- does not support `text_search`

Common asset filter keys shown in the scrape:

- `status`
- `file_type`
- `assigned`
- `file_size`
- `id`
- `categories`
- `extension`
- `created`
- `modified`
- `filename`

### `GET /filters/product`

This is the key discovery endpoint for product search construction.

System product keys shown in the scrape:

- `created`
- `modified`
- `sku`
- `gtin`
- `label`
- `status`
- `categories`
- `static_lists`
- `assets`
- `images`
- `thumbnail`
- `product_level`

Properties shown in the scrape:

- `_is_variation`
- `_has_variations`

Custom product attributes are returned prefixed with `attributes.`, for example:

- `attributes.color`
- `attributes.description`

### `GET /filters/relationships`

Common keys shown in the scrape:

- `label`
- `name`
- `created`
- `symmetrical`
- `id`
- `modified`

## Categories v1

Both file and product categories share the same shape and operational model.

### Category fields

- `id`
- `modified`
- `n_children`
- `name`
- `order`
- `parents_ids`
- `path`
- `slug`

### Create root category

- `POST /categories/file`
- `POST /categories/product`

Body:

```json
{
  "name": "Category Name"
}
```

### Create subcategory

- `POST /categories/file/:category_id`
- `POST /categories/product/:category_id`

Body:

```json
{
  "name": "Subcategory Name"
}
```

### Update category

- `PATCH /categories/file/:category_id`
- `PATCH /categories/product/:category_id`

Supported patch properties:

- `name`
- `parent_id`
  - use `""` to make the category a root category
- `sort_children`
  - full ordered list of all child ids

Rules:

- `parent_id` and `sort_children` cannot be used in the same request
- sorting root categories uses the special `/root` endpoint
- sorting subcategories requires a full child order, not a partial reorder

### Delete category

- `DELETE /categories/file/:category_id`
- `DELETE /categories/product/:category_id`

Rules:

- deleting a category deletes its entire subtree
- if you need to preserve children, move them first
- if the category or any descendant is used as an E-Catalog root category, the scrape says deletion returns `409 Conflict`

### Search categories

- `POST /categories/file/search`
- `POST /categories/product/search`

Searchable fields shown in the scrape:

- `id`
- `name`
- `path`
- `parents_ids`
- `n_children`
- `order`

Restrictions shown in the scrape:

- requested attributes must be explicitly listed, except `id`
- sorting by a non-returned attribute is allowed
- invalid field/operator/value combinations return `422`
- `pagination.page_size` max is `100`

## Products v1

### Product model

The scrape documents a product as:

- system fields:
  - `sku`
  - `label`
  - `gtin`
  - `id`
  - `created`
  - `modified`
  - `num_variations`
  - `status`
  - `assets`
  - `categories`
  - `thumbnail`
  - `attributes`
  - `product_family_id`
- custom attributes:
  - short text
  - paragraph
  - rich text
  - integer
  - decimal
  - dropdown
  - multiselect
  - URL
  - media
  - media gallery
  - boolean
  - date

### Linked field structures

#### Asset-like structure

Used for:

- `assets`
- `thumbnail`
- media attributes
- media gallery items

Fields shown:

- `id`
- `filename`
- `file_size`
- `thumbnail` or `thumb`
- `url`

#### Category structure

Fields shown:

- `id`
- `name`
- `path`

### `POST /products`

Minimal requirement:

```json
{
  "sku": "unique-sku"
}
```

Notes:

- unknown and readonly fields are ignored
- this endpoint does not create new assets or categories
- existing assets and categories can be linked at creation time
- success returns `201 Created`

### `GET /products/:product_id`

Notes:

- optional query parameter: `all_attributes=true|false`
- default is `false`
- when `true`, empty defined attributes are returned as `null`

### `PATCH /products/:product_id`

- partial update
- unspecified fields are left unchanged
- examples show patching both system fields and `attributes`

### `DELETE /products/:product_id`

Rules:

- deleting a parent product deletes its linked variants
- unlink variants first if you need to preserve them

### `POST /products/:product_id/family`

Body:

```json
{
  "product_family_id": "<product_family_id or empty string>"
}
```

Notes:

- setting `""` unassigns the family
- changing family may cause data loss
- family cannot be assigned to variant products
- changing a parent's family also affects its variants

### `POST /products/search`

Important rules from the scrape:

- up to `50` requested attributes/properties, plus `id` and `sku`
- user attributes must be requested as `attributes.<label>`
- relationship response columns must be requested as `relationships.<label>`
- requested fields must exist or the API returns `422`
- invalid field/operator/value combinations return `422`
- if more than `10000` products match and `pagination.order` is set, the API returns `428`
- `page_size` max is `100`
- only one relationship can be selected in filters

### Relationship filters in product search

The scrape documents a separate `relationship_filters` array for product search.

Structure:

```json
{
  "relationship_id": "rel_id",
  "operator": "exists",
  "product_ids": [
    {
      "id": "product_id",
      "qty_operator": "gt",
      "value": [2]
    }
  ]
}
```

Supported `operator` on relationship filter objects:

- `exists`
- `!exists`

Supported `qty_operator` values shown:

- `exists`
- `eq`
- `in`
- `gt`
- `gte`
- `lt`
- `lte`
- `bte`
- `last_days`

### Linked assets v1

#### `GET /products/:product_id/assets`

- returns linked assets

#### `GET /products/:product_id/assets/:asset_id`

- returns one linked asset

#### `POST /products/:product_id/assets`

Links an existing asset to:

- `thumbnail`
- a single media attribute
- a media gallery attribute

Body:

```json
{
  "id": "asset_id",
  "attribute_label": "thumbnail"
}
```

Rules:

- the asset must already exist
- the attribute must already exist
- thumbnail and single-media linking replace the existing asset
- media-gallery linking appends
- max `300` linked assets per product

#### `DELETE /products/:product_id/assets/:asset_id`

- unlinks the asset from the product
- does not delete the asset from the account

### Linked categories v1

#### `GET /products/:product_id/categories`

- lists linked categories

#### `GET /products/:product_id/categories/:category_id`

- returns one linked category

#### `POST /products/:product_id/categories`

Body:

```json
{
  "id": "category_id"
}
```

#### `DELETE /products/:product_id/categories/:category_id`

- unlinks the category from the product

## Variants v1

The scrape distinguishes:

- `PARENT`
- `VARIANT`
- `SINGLE`

Notes:

- variants are added through product families
- parent-level attributes can be inherited
- linking/unlinking variants may cause data loss

### `POST /products/:product_id/variant/:variant_id`

- links an existing single product as a variant of another product
- both products must belong to the same family or both be unassigned

### `DELETE /products/:parent_product_id/variant/:variant_id`

- detaches a variant and turns it back into a single product

### `POST /products/:parent_product_id/variants`

Body shape:

```json
{
  "variant": {
    "sku": "new-variant-sku",
    "label": "optional label",
    "attributes": {
      "some_attribute_label": "value"
    }
  }
}
```

Notes:

- `variant.sku` is required
- if you set a parent-level attribute on creation, it becomes overwritten on the variant

### `POST /products/:parent_product_id/variants/resync`

Body:

```json
{
  "attribute_labels": ["attr_1", "attr_2"],
  "variant_ids": ["variant_id_1", "variant_id_2"]
}
```

- resets listed parent-level attributes on listed variants back to the parent value

## Product relationship operations v1

These endpoints manage products related through an existing relationship definition.

### `POST /products/:product_id/relationships/:relationship_id`

Body:

```json
{
  "product_relationships": [
    {
      "product_id": "related_product_id",
      "quantity": 1
    }
  ]
}
```

Behavior documented in the scrape:

- existing entries are updated
- missing entries are inserted
- returns `201` when changes are made
- may return `200` when nothing changes

### `POST /products/:product_id/relationships/:relationship_id/unlink`

Body:

```json
{
  "product_relationships": [
    {
      "product_id": "related_product_id"
    }
  ]
}
```

Notes:

- detailed section documents `/unlink`
- earlier summary table and some examples are inconsistent
- success is documented as `204 No Content`

### `PATCH /products/:product_id/relationships/:relationship_id/product/:related_product_id`

Body:

```json
{
  "quantity": 10
}
```

- updates quantity for a specific related product

## Products v2 beta

The v2 beta keeps the same broad product domain, but the main shape changes are important:

- create and patch return ids and audit metadata, not the full hydrated product
- `GET /products/:id` returns linked media/categories as ids, not expanded objects
- search responses do not expand category/media structures
- relationship mutation endpoints are more forgiving and silently ignore bad ids

### v2 product fields shown in the scrape

- `id`
- `created`
- `modified`
- `created_user_audit`
- `modified_user_audit`
- `account_id`
- `sku`
- `label`
- `status`
- `attributes`
- `assets` or `asset_ids`-style content represented as ids
- `categories` or `category_ids`-style content represented as ids
- `thumbnail` as asset ids
- `relationships`
- `product_family_id`
- `overwritten_attributes`
- `product_type`
- `product_level`
- `num_variations`
- `static_list_ids`
- `mark_as_deleted`

The prose in the scrape says `asset_ids` and `category_ids`, while the example payload uses `assets` and `categories` arrays containing ids. Treat both as the v2 "ids only, not expanded objects" concept.

### `POST /products`

- creates a product
- success returns only product id and audit metadata

### `GET /products/:product_id`

- returns product data
- linked assets, categories, thumbnail, media, and media galleries are represented as ids
- to expand categories or assets, use the dedicated nested endpoints

### `PATCH /products/:product_id`

- partial update
- success returns id plus audit metadata

### `DELETE /products/:product_id`

- deletes the product
- as in v1, deleting a parent also deletes its variants unless unlinked first

### `POST /products/:product_id/family`

- same semantics as v1
- response is smaller: id + timestamps + audit metadata

### `POST /products/search`

Same major request rules as v1 product search, plus one key response difference:

- requested media/category fields are not expanded into full structures in v2 search responses

## Linked assets v2 beta

### `GET /products/:product_id/assets`

- lists expanded linked assets for the product

### `POST /products/:product_id/assets`

- same asset-linking semantics as v1
- request body still uses:

```json
{
  "id": "asset_id",
  "attribute_label": "thumbnail"
}
```

### `DELETE /products/:product_id/assets/:asset_id`

- unlinks asset from product

## Linked categories v2 beta

### `GET /products/:product_id/categories`

- lists expanded linked categories for the product

### `POST /products/:product_id/categories`

- links a category by id

### `DELETE /products/:product_id/categories/:category_id`

- unlinks category from product

## Variants v2 beta

The v2 beta variant model adds the notion of `SUB-VARIANT` in the prose, although the example responses still mainly show parent/single/variant flows.

### `POST /products/:product_id/variant/:variant_id`

- links an existing product as a variant
- prose says success is `204 No Content`
- example shows an empty JSON body; treat this as an empty-success mutation

### `DELETE /products/:parent_product_id/variant/:variant_id`

- unlinks a variant from its parent
- empty-success response

### `POST /products/:parent_product_id/variants`

Body:

```json
{
  "sku": "new-variant-sku",
  "label": "optional label",
  "attributes": {
    "some_attribute_label": "value"
  }
}
```

Notes:

- unlike v1, the request body is the variant object itself, not nested under `variant`
- success returns the new product id and audit metadata

### `POST /products/:parent_product_id/variants/resync`

- same request shape and semantics as v1

## Product relationship operations v2 beta

### `POST /products/:product_id/relationships/:relationship_id`

- request shape is still:

```json
{
  "product_relationships": [
    {
      "product_id": "related_product_id",
      "quantity": 1
    }
  ]
}
```

- documented behavior:
  - nonexistent products are silently ignored
  - already-added products are silently ignored
  - no validation-style error is returned for those cases
  - success returns `200 OK`

### `DELETE /products/:product_id/relationships/:relationship_id`

Body:

```json
{
  "product_relationships": [
    "related_product_id_1",
    "related_product_id_2"
  ]
}
```

- ids not linked to the relationship are silently ignored
- success is `204 No Content`

### `PATCH /products/:product_id/relationships/:relationship_id`

Body:

```json
{
  "product_relationships": [
    {
      "product_id": "related_product_id",
      "quantity": 9
    }
  ]
}
```

- nonexistent or unlinked products are silently ignored
- success is `200 OK`

## Product attributes v1

### Attribute types in the scrape

| Type class | PIM name | Notes |
| --- | --- | --- |
| `TextAttribute` | Short Text | short text |
| `MultilineAttribute` | Paragraph | plain multiline text |
| `HtmlAttribute` | Rich Text | HTML content |
| `IntAttribute` | Integer Number | integers |
| `DecimalAttribute` | Decimal Number | decimal numbers |
| `DropdownAttribute` | Dropdown | single select |
| `MultiSelectAttribute` | MultiSelect | multi select |
| `DateAttribute` | Date | ISO-style date values |
| `UrlAttribute` | Url | links |
| `BooleanAttribute` | Boolean | true/false |
| `MediaAttribute` | Media | single linked asset |
| `MediaGalleryAttribute` | MediaGallery | multiple linked assets |
| `CompletenessAttribute` | Completeness | completeness scoring |

### `GET /attributes/product/:product_attribute_id`

- returns one product attribute
- fields shown:
  - `id`
  - `label`
  - `name`
  - `type_class`
  - `groups`

### `PATCH /attributes/product/:product_attribute_id`

Patchable fields documented in the scrape:

- all attributes:
  - `name`
  - `description`
- dropdown and multiselect:
  - `options`
    - replacing options replaces the full existing option set
- completeness attributes:
  - `attributes`

## Known scrape artifacts and contradictions

These were normalized in this cleaned version instead of copied verbatim.

- The raw scrape contains many repeated `Body` / `Headers (N)` UI fragments.
- Many JSON examples contain escaped backslashes from the scraper.
- The initial resource summary lists `GET /filters/products`; the detailed section uses `GET /filters/product`. This document uses `filters/product`.
- Product relationship unlinking in v1 is inconsistent:
  - summary table shows `/products/:id/relationships/:id/unlink`
  - detailed heading shows `POST .../unlink`
  - one example omits `/unlink`
- The v1 `GET /products/:product_id/variants` section includes a malformed example curl using `POST`.
- Several example headings show `200 OK` while the prose and empty-body behavior imply `204 No Content`.
- v2 prose describes ids-only fields with names like `asset_ids` and `category_ids`, while examples often use `assets` and `categories` arrays that contain ids. The meaningful difference is that v2 core product responses do not expand linked entities.

## Practical takeaways

- Use auth token flow first; tokens are short-lived.
- Use `GET /api/v1/filters/product` to discover valid product attribute labels and filter operators.
- Use product search with explicit `attributes`.
- Use v2 product endpoints if you want the newer lightweight product payloads.
- Use nested assets/categories endpoints when you need expanded linked objects in v2.
- Expect search hard limits around:
  - `page_size <= 100`
  - `428` when ordering very large result sets
  - product search attribute limit of `50`

