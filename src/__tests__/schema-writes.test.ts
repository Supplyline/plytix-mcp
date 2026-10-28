import { describe, expect, it } from 'vitest';
import {
  attributeCreateBody,
  attributeUpdateBody,
  buildCategoryDeletePreview,
  buildProductDeletePreview,
  categoryUpdateBody,
  checkSortChildren,
  resolveOptionEdit,
  validateAttributeCreate,
} from '../schema-writes.js';
import type { PlytixAttributeDetail } from '../types.js';

const dropdown: PlytixAttributeDetail = {
  id: 'attr-1',
  label: 'colour',
  name: 'Colour',
  type_class: 'DropdownAttribute',
  options: ['Red', 'Blue', 'Green'],
};

const text: PlytixAttributeDetail = {
  id: 'attr-2',
  label: 'notes',
  name: 'Notes',
  type_class: 'TextAttribute',
};

describe('validateAttributeCreate', () => {
  it('accepts a plain boolean attribute', () => {
    expect(validateAttributeCreate({ name: 'In Stock', type_class: 'BooleanAttribute' })).toEqual([]);
  });

  it('rejects an unknown type_class and the retired MultilineAttribute', () => {
    expect(validateAttributeCreate({ name: 'x', type_class: 'Nope' })[0]).toMatch(/type_class must be one of/);
    expect(validateAttributeCreate({ name: 'x', type_class: 'MultilineAttribute' })[0]).toMatch(/type_class/);
  });

  it('rejects options on a non-select type', () => {
    const errors = validateAttributeCreate({ name: 'x', type_class: 'TextAttribute', options: ['a'] });
    expect(errors).toEqual(['options applies only to DropdownAttribute and MultiSelectAttribute']);
  });

  it('rejects duplicate and empty options', () => {
    const errors = validateAttributeCreate({
      name: 'x',
      type_class: 'DropdownAttribute',
      options: ['a', 'a', ' '],
    });
    expect(errors).toEqual(['options contains duplicates: a', 'options cannot contain empty values']);
  });

  it('requires tracked attributes on a completeness attribute and refuses them elsewhere', () => {
    expect(validateAttributeCreate({ name: 'x', type_class: 'CompletenessAttribute' })).toEqual([
      'attributes (the tracked attributes) is required for CompletenessAttribute',
    ]);
    expect(
      validateAttributeCreate({ name: 'x', type_class: 'IntAttribute', attributes: [{ id: null, label: 'sku' }] })
    ).toEqual(['attributes applies only to CompletenessAttribute']);
  });

  it('validates product_families entries', () => {
    const errors = validateAttributeCreate({
      name: 'x',
      type_class: 'TextAttribute',
      product_families: [{ id: '', attribute_level: 'top_level' as never }],
    });
    expect(errors[0]).toBe('product_families entries need an id');
    expect(errors[1]).toMatch(/attribute_level must be one of/);
  });
});

describe('attributeCreateBody', () => {
  it('sends only the fields given and defaults attribute_level to no_level', () => {
    expect(
      attributeCreateBody({
        name: '  Size ',
        type_class: 'DropdownAttribute',
        options: ['S', 'M'],
        product_families: [{ id: 'fam-1' }, { id: 'fam-2', attribute_level: 'variant_level' }],
      })
    ).toEqual({
      name: 'Size',
      type_class: 'DropdownAttribute',
      options: ['S', 'M'],
      product_families: [
        { id: 'fam-1', attribute_level: 'no_level' },
        { id: 'fam-2', attribute_level: 'variant_level' },
      ],
    });
  });
});

describe('resolveOptionEdit', () => {
  const current = ['Red', 'Blue', 'Green'];

  it('reports no change when nothing is requested', () => {
    const result = resolveOptionEdit(current, {});
    expect(result).toEqual({ ok: true, added: [], removed: [], renamed: {}, already_present: [] });
  });

  it('appends new options and skips ones already present', () => {
    const result = resolveOptionEdit(current, { add_options: ['Blue', 'Black'] });
    expect(result).toMatchObject({
      ok: true,
      options: ['Red', 'Blue', 'Green', 'Black'],
      added: ['Black'],
      already_present: ['Blue'],
    });
  });

  it('omits options when an add changes nothing', () => {
    const result = resolveOptionEdit(current, { add_options: ['Red'] });
    expect(result.ok && result.options).toBeUndefined();
    expect(result.ok && result.already_present).toEqual(['Red']);
  });

  it('removes in order and refuses an unknown option', () => {
    expect(resolveOptionEdit(current, { remove_options: ['Blue'] })).toMatchObject({
      ok: true,
      options: ['Red', 'Green'],
      removed: ['Blue'],
    });
    expect(resolveOptionEdit(current, { remove_options: ['Pink'] })).toEqual({
      ok: false,
      reason: 'remove_options: "Pink" is not a current option.',
    });
  });

  it('renames in place and sends the rename map alongside the full list', () => {
    const result = resolveOptionEdit(current, { renamed_options: { Blue: 'Navy' } });
    expect(result).toMatchObject({
      ok: true,
      options: ['Red', 'Navy', 'Green'],
      renamed_options: { Blue: 'Navy' },
      renamed: { Blue: 'Navy' },
    });
  });

  it('applies remove, rename, add in that order', () => {
    const result = resolveOptionEdit(current, {
      remove_options: ['Green'],
      renamed_options: { Red: 'Crimson' },
      add_options: ['White'],
    });
    expect(result.ok && result.options).toEqual(['Crimson', 'Blue', 'White']);
  });

  it('enforces the documented rename restrictions', () => {
    expect(resolveOptionEdit(current, { renamed_options: { Red: 'Blue' } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('already an option'),
    });
    expect(resolveOptionEdit(current, { renamed_options: { Red: 'X', Blue: 'X' } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('same name'),
    });
    expect(resolveOptionEdit(current, { renamed_options: { Pink: 'X' } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not a current option'),
    });
    expect(resolveOptionEdit(current, { remove_options: ['Red'], renamed_options: { Red: 'X' } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('both removed and renamed'),
    });
  });

  it('refuses options together with incremental edits', () => {
    expect(resolveOptionEdit(current, { options: ['A'], add_options: ['B'] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not both'),
    });
  });

  it('refuses incremental edits when the attribute has no options list', () => {
    expect(resolveOptionEdit(undefined, { add_options: ['A'] })).toMatchObject({ ok: false });
  });

  it('accepts a full replacement and requires renamed values to appear in it', () => {
    expect(resolveOptionEdit(current, { options: ['Red', 'Navy'], renamed_options: { Blue: 'Navy' } })).toMatchObject({
      ok: true,
      options: ['Red', 'Navy'],
      renamed_options: { Blue: 'Navy' },
      added: [],
      removed: ['Green'],
    });
    expect(resolveOptionEdit(current, { options: ['Red'], renamed_options: { Blue: 'Navy' } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not in options'),
    });
  });

  it('treats an identical replacement list as no change', () => {
    const result = resolveOptionEdit(current, { options: [...current] });
    expect(result.ok && result.options).toBeUndefined();
  });
});

describe('attributeUpdateBody', () => {
  it('builds name/description patches for any type', () => {
    const result = attributeUpdateBody(text, { name: ' Notes 2 ', description: 'd' });
    expect(result).toMatchObject({ ok: true, body: { name: 'Notes 2', description: 'd' } });
  });

  it('returns no body when nothing changes', () => {
    const result = attributeUpdateBody(dropdown, { add_options: ['Red'] });
    expect(result.ok && result.body).toBeUndefined();
  });

  it('refuses option edits on a text attribute', () => {
    expect(attributeUpdateBody(text, { add_options: ['x'] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('TextAttribute'),
    });
  });

  it('sends the full list with renamed_options', () => {
    const result = attributeUpdateBody(dropdown, { renamed_options: { Green: 'Lime' } });
    expect(result.ok && result.body).toEqual({
      options: ['Red', 'Blue', 'Lime'],
      renamed_options: { Green: 'Lime' },
    });
  });

  it('only allows attributes on a completeness attribute', () => {
    expect(attributeUpdateBody(text, { attributes: [{ id: null, label: 'sku' }] })).toMatchObject({ ok: false });
  });
});

describe('categoryUpdateBody', () => {
  it('refuses an empty patch and the parent_id + sort_children combination', () => {
    expect(categoryUpdateBody({})).toMatchObject({ ok: false, reason: expect.stringContaining('Nothing to update') });
    expect(categoryUpdateBody({ parent_id: 'p', sort_children: ['a'] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('same request'),
    });
  });

  it('keeps an empty parent_id (make root) and trims the name', () => {
    expect(categoryUpdateBody({ name: ' Pumps ', parent_id: '' })).toEqual({
      ok: true,
      body: { name: 'Pumps', parent_id: '' },
    });
  });

  it('rejects duplicate child ids', () => {
    expect(categoryUpdateBody({ sort_children: ['a', 'a'] })).toMatchObject({ ok: false });
  });
});

describe('checkSortChildren', () => {
  const children = [
    { id: 'a', name: 'A', path: ['A'] },
    { id: 'b', name: 'B', path: ['B'] },
  ];

  it('accepts a complete permutation', () => {
    expect(checkSortChildren(['b', 'a'], children)).toEqual({ ok: true });
  });

  it('names missing and unknown ids', () => {
    const result = checkSortChildren(['a', 'z'], children);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain('missing current children: b');
      expect(result.reason).toContain('not children of this category: z');
    }
  });
});

describe('delete previews', () => {
  it('warns about variants and offers unlink_variants', () => {
    const preview = buildProductDeletePreview(
      { id: 'p', sku: 'PARENT', product_type: 'PARENT' },
      [{ id: 'v1', sku: 'V1' }, { id: 'v2', sku: 'V2' }],
      false
    );
    expect(preview.variant_count).toBe(2);
    expect(preview.warning).toContain('also deletes its 2 variants');
    expect(buildProductDeletePreview({ id: 'p', sku: 'PARENT' }, [{ id: 'v1', sku: 'V1' }], true).warning).toContain(
      'unlinked'
    );
  });

  it('truncates a long variant list', () => {
    const variants = Array.from({ length: 30 }, (_, i) => ({ id: `v${i}`, sku: `V${i}` }));
    const preview = buildProductDeletePreview({ id: 'p', sku: 'PARENT' }, variants, false);
    expect((preview.variants as unknown[]).length).toBe(25);
    expect(preview.variants_truncated).toBe(5);
  });

  it('warns about a subtree and describes a move', () => {
    const category = { id: 'c', name: 'Pumps', path: ['Pumps'], n_children: 2 };
    const children = [
      { id: 'c1', name: 'Gear', path: ['Pumps', 'Gear'] },
      { id: 'c2', name: 'Vane', path: ['Pumps', 'Vane'] },
    ];
    expect(buildCategoryDeletePreview(category, children, undefined).warning).toContain('entire subtree');
    expect(buildCategoryDeletePreview(category, children, '').warning).toContain('root level');
    expect(buildCategoryDeletePreview(category, children, 'other').children_moved_to).toBe('other');
    expect(buildCategoryDeletePreview({ ...category, n_children: 0 }, [], undefined).warning).toContain('no children');
  });
});
