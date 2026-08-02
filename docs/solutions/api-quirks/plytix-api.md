# Plytix API Reference for Agents

Compressed reference derived from the supplied March 11, 2026 scrape.

## 1. Base URLs

- Auth: `https://auth.plytix.com/auth/api/get-token`
- API v1: `https://pim.plytix.com/api/v1`
- API v2 beta: `https://pim.plytix.com/api/v2`

## 2. Auth

Get a bearer token with:

```json
POST https://auth.plytix.com/auth/api/get-token
{
  "api_key": "...",
  "api_password": "..."
}
```

Token comes back at:

```json
data[0].access_token
```

Rules:

- token TTL is 15 minutes
- send `Authorization: Bearer <token>`
- send `Content-Type: application/json`

## 3. Universal response format

Success:

```json
{"data":[...], "pagination": {...}}
```

Error:

```json
{"error":{"msg":"...", "errors":[{"field":"...","msg":"..."}]}}
```

## 4. Search DSL

`filters` is OR-of-ANDs:

- outer array = `OR`
- each inner array = `AND`
- each filter = `{field, operator, value}`

Example:

```json
{
  "filters": [
    [
      {"field":"status","operator":"eq","value":"Completed"},
      {"field":"attributes.volume_liters","operator":"gt","value":3}
    ],
    [
      {"field":"sku","operator":"like","value":"mug"}
    ]
  ]
}
```

Common operators:

- `exists`, `!exists`
- `eq`, `!eq`
- `like`
- `in`, `!in`
- `gt`, `gte`, `lt`, `lte`
- `text_search`

Pagination:

```json
{
  "pagination": {
    "page": 1,
    "page_size": 25,
    "order": "-sku"
  }
}
```

Rules:

- default page size is 25
- max `page_size` is usually 100
- `order` format is `field` or `-field`

## 5. Version choice

Use `v2` for product operations unless you specifically need an older v1 behavior.

Use `v1` for:

- auth
- accounts search
- assets resource
- filter metadata
- file/product category resources
- product attributes
- product families in this scrape

Use `v2 beta` for:

- products
- product-linked assets
- product-linked categories
- variants
- product relationship mutations

## 6. Product search rules

Main endpoint:

- `POST /api/v2/products/search`

Important rules:

- user attributes must be requested as `attributes.<label>`
- relationship columns must be requested as `relationships.<label>`
- discover valid labels/operators with `GET /api/v1/filters/product`
- product search allows up to 50 requested attributes/properties plus `id` and `sku`
- if more than 10,000 results match and `pagination.order` is set, expect `428`
- only one relationship can be selected in filters

Example:

```json
{
  "filters": [
    [
      {"field":"status","operator":"eq","value":"Completed"},
      {"field":"attributes.volume_liters","operator":"gt","value":3}
    ]
  ],
  "attributes": [
    "label",
    "status",
    "modified",
    "attributes.volume_liters"
  ],
  "pagination": {
    "order": "attributes.volume_liters",
    "page": 1,
    "page_size": 25
  }
}
```

## 7. Product hydration pattern

Recommended flow:

1. Search products with `POST /api/v2/products/search`
2. Get a specific product with `GET /api/v2/products/:product_id`
3. Hydrate linked assets/categories separately if needed:
   - `GET /api/v2/products/:product_id/assets`
   - `GET /api/v2/products/:product_id/categories`

Reason:

- v2 product/search responses do not expand linked media/categories into full objects
- they return ids or id-like arrays instead

## 8. Core product endpoints

### v2 products

- `POST /api/v2/products`
- `GET /api/v2/products/:product_id`
- `PATCH /api/v2/products/:product_id`
- `DELETE /api/v2/products/:product_id`
- `POST /api/v2/products/:product_id/family`

Behavior:

- create and patch return id + timestamps/audit metadata, not full product bodies
- deleting a parent product also deletes its variants unless you unlink them first
- assigning/changing family can cause data loss
- family cannot be assigned to variant products

Minimal create:

```json
{
  "sku": "unique-sku"
}
```

## 9. Assets

### Account-level assets are v1

- `POST /api/v1/assets`
- `POST /api/v1/assets/search`
- `GET /api/v1/assets/:asset_id`
- `PATCH /api/v1/assets/:asset_id`
- `DELETE /api/v1/assets/:asset_id`
- `PUT /api/v1/assets/:asset_id/content`

Upload modes:

1. by public URL
2. by raw base64 content

Notes:

- base64 upload should not include the `data:image/...;base64,` prefix
- `PUT /content` uses `multipart/form-data`

### Product-linked asset endpoints

- `GET /api/v2/products/:product_id/assets`
- `POST /api/v2/products/:product_id/assets`
- `DELETE /api/v2/products/:product_id/assets/:asset_id`

Link body:

```json
{
  "id": "asset_id",
  "attribute_label": "thumbnail"
}
```

Rules:

- links existing assets only
- `thumbnail` and single-media attrs are replace semantics
- media-gallery attrs append
- limit: 300 linked assets per product

## 10. Categories

### Category resources are v1

File categories:

- `POST /api/v1/categories/file`
- `POST /api/v1/categories/file/:category_id`
- `PATCH /api/v1/categories/file/:category_id`
- `PATCH /api/v1/categories/file/root`
- `DELETE /api/v1/categories/file/:category_id`
- `POST /api/v1/categories/file/search`

Product categories:

- `POST /api/v1/categories/product`
- `POST /api/v1/categories/product/:category_id`
- `PATCH /api/v1/categories/product/:category_id`
- `PATCH /api/v1/categories/product/root`
- `DELETE /api/v1/categories/product/:category_id`
- `POST /api/v1/categories/product/search`

Important rules:

- deleting a category deletes its subtree
- move children first if you need to preserve them
- `parent_id` and `sort_children` cannot be combined in one patch
- sorting child categories requires the full ordered child list

### Product-linked category endpoints

- `GET /api/v2/products/:product_id/categories`
- `POST /api/v2/products/:product_id/categories`
- `DELETE /api/v2/products/:product_id/categories/:category_id`

Link body:

```json
{"id":"category_id"}
```

## 11. Variants

### v2 variant endpoints

- `POST /api/v2/products/:product_id/variant/:variant_id`
- `DELETE /api/v2/products/:parent_product_id/variant/:variant_id`
- `POST /api/v2/products/:parent_product_id/variants`
- `POST /api/v2/products/:parent_product_id/variants/resync`

Rules:

- linking/unlinking variants can cause data loss
- products must share family or both be unassigned when linking
- v2 create-variant body is direct, not nested under `variant`

Create variant:

```json
{
  "sku": "new-variant-sku",
  "label": "optional label",
  "attributes": {
    "some_attribute_label": "value"
  }
}
```

Resync:

```json
{
  "attribute_labels": ["attr_1", "attr_2"],
  "variant_ids": ["variant_id_1", "variant_id_2"]
}
```

## 12. Relationships

### v2 product relationship mutations

- `POST /api/v2/products/:product_id/relationships/:relationship_id`
- `PATCH /api/v2/products/:product_id/relationships/:relationship_id`
- `DELETE /api/v2/products/:product_id/relationships/:relationship_id`

Assign/update body:

```json
{
  "product_relationships": [
    {"product_id":"related_product_id","quantity":1}
  ]
}
```

Delete body:

```json
{
  "product_relationships": ["related_product_id_1", "related_product_id_2"]
}
```

Important v2 behavior:

- nonexistent product ids are silently ignored
- already-linked ids are silently ignored on add
- unlinked ids are silently ignored on delete/patch
- these endpoints favor empty-success over strict validation

### Relationship filters in product search

Use `relationship_filters` alongside normal `filters`.

Shape:

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

`qty_operator` values shown in scrape:

- `exists`
- `eq`
- `in`
- `gt`
- `gte`
- `lt`
- `lte`
- `bte`
- `last_days`

## 13. Filter discovery endpoints

Use these to build valid searches:

- `GET /api/v1/filters/asset`
- `GET /api/v1/filters/product`
- `GET /api/v1/filters/relationships`

Returned filter metadata includes:

- `key`
- `operators`
- `options` when enum-like
- `filter_type`

## 14. Product attribute metadata

Product attributes are still documented under v1.

- `GET /api/v1/attributes/product/:product_attribute_id`
- `PATCH /api/v1/attributes/product/:product_attribute_id`

Common type classes:

- `TextAttribute`
- `MultilineAttribute`
- `HtmlAttribute`
- `IntAttribute`
- `DecimalAttribute`
- `DropdownAttribute`
- `MultiSelectAttribute`
- `DateAttribute`
- `UrlAttribute`
- `BooleanAttribute`
- `MediaAttribute`
- `MediaGalleryAttribute`
- `CompletenessAttribute`

Patchable fields:

- all attrs: `name`, `description`
- dropdown/multiselect: `options` replaces full set
- completeness: `attributes`

## 15. Accounts endpoints

- `POST /api/v1/accounts/memberships/search`
- `POST /api/v1/accounts/api-credentials/search`

Notes:

- sorting not supported
- if `attributes` is omitted, all fields are returned

## 16. High-value gotchas

- Token expires after 15 minutes.
- Product search uses attribute labels, not display names.
- Prefix custom product fields with `attributes.`.
- Use v2 for product CRUD/search, but v1 for filter metadata and most catalog metadata resources.
- v2 product GET/search does not expand linked assets/categories/media; hydrate separately.
- `page_size > 100` typically fails with `422`.
- Ordered searches over very large result sets can fail with `428`.
- Category delete is recursive.
- Linking/unlinking variants can destroy inherited data shape.
- v2 relationship mutations silently ignore many bad ids instead of erroring.

## 17. Minimal working sequence

1. Authenticate.
2. Discover product labels/operators with `GET /api/v1/filters/product`.
3. Search via `POST /api/v2/products/search`.
4. Fetch a product via `GET /api/v2/products/:product_id`.
5. Hydrate assets/categories with nested v2 endpoints if needed.

