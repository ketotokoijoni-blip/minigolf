import { describe, expect, it } from 'vitest';
import { MAX_COURSES_PER_SET } from '@puttipeli/shared/constants';
import { BUILTIN_COURSES } from '@puttipeli/shared/course/builtin';
import { courseId } from '@puttipeli/shared/course/canonical';
import { decodeLayers } from '@puttipeli/shared/course/parse';
import type { Course, CourseRef } from '@puttipeli/shared/course/types';
import { MAX_COURSE_BYTES } from '@puttipeli/shared/protocol/limits';
import { CourseStore, withServerId } from './courseStore';

const b01 = BUILTIN_COURSES[0]!;
const custom = (patch: Partial<Course>): Course => ({ ...b01, id: '', name: 'Oma rata', author: 'Testi', ...patch });

describe('CourseStore.resolve', () => {
  it('resolves built-in refs to the shared course objects in order', () => {
    const store = new CourseStore();
    const res = store.resolve([{ kind: 'builtin', id: 'b_03' }, { kind: 'builtin', id: 'b_01' }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.courses.map((c) => c.id)).toEqual(['b_03', 'b_01']);
    if (res.ok) expect(res.courses[1]).toBe(b01);
  });

  it('rejects unknown built-in ids, empty and oversized sets with INVALID_COURSE', () => {
    const store = new CourseStore();
    const unknown = store.resolve([{ kind: 'builtin', id: 'b_99' }]);
    expect(unknown).toMatchObject({ ok: false, code: 'INVALID_COURSE' });
    expect(store.resolve([])).toMatchObject({ ok: false, code: 'INVALID_COURSE' });
    const many: CourseRef[] = Array.from({ length: MAX_COURSES_PER_SET + 1 }, () => ({ kind: 'builtin', id: 'b_01' }));
    expect(store.resolve(many)).toMatchObject({ ok: false, code: 'INVALID_COURSE' });
    expect(store.resolve(many.slice(0, MAX_COURSES_PER_SET)).ok).toBe(true);
  });

  it('accepts a valid custom course and recomputes its id', () => {
    const store = new CourseStore();
    const course = custom({ id: 'c_0000000000000000' });
    const res = store.resolve([{ kind: 'custom', course }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = res.courses[0]!;
    expect(out.id).toMatch(/^c_[0-9a-f]{16}$/);
    expect(out.id).toBe(courseId({ ...course, id: '' }));
    expect(out.name).toBe('Oma rata');
  });

  it('reports validation issues (with the course index) for an invalid custom course', () => {
    const store = new CourseStore();
    const noHole = custom({ objects: b01.objects.filter((o) => o.type !== 'hole') });
    const res = store.resolve([{ kind: 'builtin', id: 'b_01' }, { kind: 'custom', course: noHole }]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('INVALID_COURSE');
    expect(res.issues?.some((i) => i.code === 'NO_HOLE')).toBe(true);
    expect(res.issues?.[0]?.params?.courseIndex).toBe(1);
    expect(res.message).toContain('Course 2');
  });

  it('rejects a structurally broken course file and an oversized course', () => {
    const store = new CourseStore();
    const broken = { ...b01, format: 'something-else' } as unknown as Course;
    const res = store.resolve([{ kind: 'custom', course: broken }]);
    expect(res).toMatchObject({ ok: false, code: 'INVALID_COURSE' });
    if (!res.ok) expect(res.issues?.[0]?.code).toBe('FORMAT_UNKNOWN');

    const mines: Course['objects'] = [];
    for (let y = 1; y < 24; y++) for (let x = 5; x < 43; x++) if (!(x === 44 && y === 12)) mines.push({ type: 'mine', x, y });
    const huge = custom({ objects: [...b01.objects, ...mines] });
    const big = store.resolve([{ kind: 'custom', course: huge }]);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.issues?.some((i) => i.code === 'TOO_LARGE' || i.code === 'OBJECT_OVERLAP')).toBe(true);
    expect(MAX_COURSE_BYTES).toBeGreaterThan(0);
  });
});

describe('withServerId (R13: built-in ids are reserved)', () => {
  it('a byte-identical copy of a built-in resolves to the built-in object', () => {
    const copy: Course = JSON.parse(JSON.stringify(b01));
    expect(withServerId(copy)).toBe(b01);
    const store = new CourseStore();
    const res = store.resolve([{ kind: 'custom', course: copy }]);
    if (res.ok) expect(res.courses[0]).toBe(b01);
    expect(res.ok).toBe(true);
  });

  it('a different course claiming b_01 (or an unknown b_NN) gets a content-hash id', () => {
    const fake = custom({ id: 'b_01', name: 'Ei oikeasti b_01' });
    const out = withServerId(fake);
    expect(out.id).toMatch(/^c_[0-9a-f]{16}$/);
    expect(out.id).toBe(courseId({ ...fake, id: '' }));
    expect(withServerId(custom({ id: 'b_42' })).id).toMatch(/^c_/);
    const store = new CourseStore();
    const res = store.resolve([{ kind: 'custom', course: fake }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.courses[0]!.id).toMatch(/^c_/);
  });

  it('a wrong c_ id is corrected, a right one is kept', () => {
    const c = custom({});
    const right = { ...c, id: courseId(c) };
    expect(withServerId(right)).toBe(right);
    expect(withServerId({ ...c, id: 'c_ffffffffffffffff' }).id).toBe(right.id);
  });
});

describe('CourseStore.layersFor', () => {
  it('caches decoded layers per id and returns the same instance', () => {
    const store = new CourseStore();
    const a = store.layersFor(b01);
    expect(store.layersFor(b01)).toBe(a);
    expect(a.start).toEqual(decodeLayers(b01).start);
    expect(store.cachedLayerCount()).toBe(1);
  });

  it('evicts the oldest custom layers beyond the cap but never built-ins', () => {
    const store = new CourseStore(2);
    for (const b of BUILTIN_COURSES) store.layersFor(b);
    const c1 = withServerId(custom({ name: 'A' }));
    const c2 = withServerId(custom({ name: 'B' }));
    const c3 = withServerId(custom({ name: 'C' }));
    const l1 = store.layersFor(c1);
    store.layersFor(c2);
    store.layersFor(c3);
    expect(store.cachedLayerCount()).toBe(BUILTIN_COURSES.length + 2);
    expect(store.layersFor(c1)).not.toBe(l1); // evicted and decoded again
    expect(store.layersFor(BUILTIN_COURSES[8]!)).toBe(store.layersFor(BUILTIN_COURSES[8]!));
  });
});
