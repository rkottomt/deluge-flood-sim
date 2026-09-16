/**
 * Indexed binary min-heap over integer ids 0..capacity-1, ordered by an external Float64Array of keys
 * (Dijkstra's tentative distances). Supports decrease-key in O(log n) without duplicate entries, so the
 * heap never grows beyond the node count and needs no allocation after construction.
 */
export class IndexedMinHeap {
  /** heap[k] = id stored at heap slot k. */
  private readonly heap: Int32Array;
  /** pos[id] = slot of id in the heap, or -1 when not in the heap. */
  private readonly pos: Int32Array;
  private n = 0;

  constructor(
    capacity: number,
    private readonly keys: Float64Array,
  ) {
    this.heap = new Int32Array(Math.max(1, capacity));
    this.pos = new Int32Array(Math.max(1, capacity)).fill(-1);
  }

  get size(): number {
    return this.n;
  }

  /** Remove everything (O(size), not O(capacity)). */
  clear(): void {
    for (let k = 0; k < this.n; k++) this.pos[this.heap[k]] = -1;
    this.n = 0;
  }

  /** The id with the smallest key. Only valid when size > 0. */
  peek(): number {
    return this.heap[0];
  }

  /** Insert `id`, or restore heap order after its key decreased. */
  pushOrDecrease(id: number): void {
    let k = this.pos[id];
    if (k < 0) {
      k = this.n++;
      this.heap[k] = id;
      this.pos[id] = k;
    }
    this.siftUp(k);
  }

  pop(): number {
    const heap = this.heap;
    const top = heap[0];
    this.pos[top] = -1;
    const last = heap[--this.n];
    if (this.n > 0) {
      heap[0] = last;
      this.pos[last] = 0;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(k: number): void {
    const heap = this.heap, pos = this.pos, keys = this.keys;
    const id = heap[k];
    const key = keys[id];
    while (k > 0) {
      const parent = (k - 1) >> 1;
      const pid = heap[parent];
      if (keys[pid] <= key) break;
      heap[k] = pid;
      pos[pid] = k;
      k = parent;
    }
    heap[k] = id;
    pos[id] = k;
  }

  private siftDown(k: number): void {
    const heap = this.heap, pos = this.pos, keys = this.keys, n = this.n;
    const id = heap[k];
    const key = keys[id];
    for (;;) {
      const l = 2 * k + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && keys[heap[r]] < keys[heap[l]] ? r : l;
      const cid = heap[c];
      if (keys[cid] >= key) break;
      heap[k] = cid;
      pos[cid] = k;
      k = c;
    }
    heap[k] = id;
    pos[id] = k;
  }
}
