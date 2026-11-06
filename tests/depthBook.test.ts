import { describe, expect, it } from "vitest";
import { FuturesDepthBook, type DepthDiff } from "../src/market/depthBook";

function diff(partial: Partial<DepthDiff> & Pick<DepthDiff, "U" | "u" | "pu">): DepthDiff {
  return { bids: [], asks: [], ...partial };
}

describe("USD-M futures depth sync", () => {
  it("buffers diffs until the snapshot, then bridges an overlapping first event", () => {
    const book = new FuturesDepthBook(0.1);
    expect(book.onDiff(diff({ U: 5, u: 9, pu: 4, bids: [["100", "9"]] })).type).toBe("buffered");
    expect(book.synced).toBe(false);
    const result = book.applySnapshot(10, [["100", "1"], ["99.9", "2"]], [["100.2", "3"]]);
    expect(result).toEqual({ type: "snapshot", bridged: false });
    expect(book.synced).toBe(true);
    expect(book.qty("bid", "100")).toBe(1);
    expect(book.qty("ask", "100.2")).toBe(3);

    const applied = book.onDiff(diff({ U: 8, u: 12, pu: 7, bids: [["100", "4"]] }));
    expect(applied.type).toBe("applied");
    expect(book.qty("bid", "100")).toBe(4);
    expect(book.updateId).toBe(12);
    expect(book.hasBridge).toBe(true);
  });

  it("replaces quantities and deletes zero levels, including a level that was absent", () => {
    const book = new FuturesDepthBook(0.1);
    book.applySnapshot(10, [["100", "1"]], [["101", "2"]]);
    book.onDiff(diff({ U: 10, u: 11, pu: 9, bids: [["100", "4"]], asks: [["101", "0"]] }));
    expect(book.qty("bid", "100")).toBe(4);
    expect(book.qty("ask", "101")).toBe(0);
    const removed = book.onDiff(diff({ U: 11, u: 12, pu: 11, bids: [["100", "0"]], asks: [["150", "0"]] }));
    expect(removed.type).toBe("applied");
    expect(book.qty("bid", "100")).toBe(0);
    expect(book.qty("ask", "150")).toBe(0);
    expect(book.qty("ask", "101")).toBe(0);
  });

  it("ignores a duplicate of the last applied event", () => {
    const book = new FuturesDepthBook(0.1);
    book.applySnapshot(10, [["100", "1"]], [["101", "1"]]);
    const event = diff({ U: 10, u: 11, pu: 9, bids: [["100", "6"]] });
    expect(book.onDiff(event).type).toBe("applied");
    expect(book.onDiff(event).type).toBe("ignored");
    expect(book.qty("bid", "100")).toBe(6);
    expect(book.updateId).toBe(11);
    expect(book.synced).toBe(true);
  });

  it("ignores an older out-of-order event and refuses a pu gap without applying it", () => {
    const book = new FuturesDepthBook(0.1);
    book.applySnapshot(10, [["100", "1"]], [["101", "1"]]);
    book.onDiff(diff({ U: 10, u: 11, pu: 9, bids: [["100", "2"]] }));
    expect(book.onDiff(diff({ U: 8, u: 10, pu: 7, bids: [["100", "99"]] })).type).toBe("ignored");
    expect(book.qty("bid", "100")).toBe(2);

    const gap = book.onDiff(diff({ U: 13, u: 14, pu: 12, bids: [["100", "50"]] }));
    expect(gap).toEqual({ type: "gap", reason: "sequence" });
    expect(book.qty("bid", "100")).toBe(2);
    expect(book.synced).toBe(false);
    expect(book.onDiff(diff({ U: 14, u: 15, pu: 14, bids: [["100", "80"]] })).type).toBe("buffered");
    expect(book.qty("bid", "100")).toBe(2);
  });

  it("accepts a futures jump where U skips ahead but pu chains", () => {
    const book = new FuturesDepthBook(0.1);
    book.applySnapshot(100, [["100", "1"]], [["101", "1"]]);
    book.onDiff(diff({ U: 90, u: 110, pu: 80, bids: [["100", "2"]] }));
    const jumped = book.onDiff(diff({ U: 200, u: 210, pu: 110, bids: [["100", "3"]] }));
    expect(jumped.type).toBe("applied");
    expect(book.qty("bid", "100")).toBe(3);
    expect(book.updateId).toBe(210);
  });

  it("does not keep a bridged book alive on overlap alone when pu breaks", () => {
    const book = new FuturesDepthBook(0.1);
    book.applySnapshot(100, [["100", "1"]], [["101", "1"]]);
    book.onDiff(diff({ U: 100, u: 110, pu: 99, bids: [["100", "2"]] }));
    const gap = book.onDiff(diff({ U: 100, u: 150, pu: 90, bids: [["100", "40"]] }));
    expect(gap).toEqual({ type: "gap", reason: "sequence" });
    expect(book.qty("bid", "100")).toBe(2);
    expect(book.synced).toBe(false);
  });

  it("bridges the first event on overlap even if pu is older, or on pu alone", () => {
    const overlap = new FuturesDepthBook(0.1);
    overlap.applySnapshot(100, [["100", "1"]], [["101", "1"]]);
    expect(overlap.onDiff(diff({ U: 50, u: 110, pu: 40, bids: [["100", "5"]] })).type).toBe("applied");
    expect(overlap.qty("bid", "100")).toBe(5);

    const chained = new FuturesDepthBook(0.1);
    chained.applySnapshot(100, [["100", "1"]], [["101", "1"]]);
    expect(chained.onDiff(diff({ U: 101, u: 105, pu: 100, asks: [["101", "8"]] })).type).toBe("applied");
    expect(chained.qty("ask", "101")).toBe(8);

    const hole = new FuturesDepthBook(0.1);
    hole.applySnapshot(100, [["100", "1"]], [["101", "2"]]);
    expect(hole.onDiff(diff({ U: 102, u: 105, pu: 101, bids: [["100", "9"]] }))).toEqual({
      type: "gap",
      reason: "bridge",
    });
    expect(hole.qty("bid", "100")).toBe(1);
    expect(hole.synced).toBe(false);
  });

  it("sorts a pre-snapshot buffer, drops stale rows, and keeps the later duplicate", () => {
    const book = new FuturesDepthBook(0.1);
    book.onDiff(diff({ U: 11, u: 12, pu: 11, bids: [["100", "3"]] }));
    book.onDiff(diff({ U: 9, u: 11, pu: 8, bids: [["100", "2"]] }));
    book.onDiff(diff({ U: 4, u: 9, pu: 3, bids: [["100", "50"]] }));
    book.onDiff(diff({ U: 11, u: 12, pu: 11, bids: [["100", "7"]] }));
    const result = book.applySnapshot(10, [["100", "1"]], [["101", "1"]]);
    expect(result).toEqual({ type: "snapshot", bridged: true });
    expect(book.qty("bid", "100")).toBe(7);
    expect(book.updateId).toBe(12);
  });

  it("stops the snapshot replay on a buffered gap and does not apply the broken event", () => {
    const book = new FuturesDepthBook(0.1);
    book.onDiff(diff({ U: 10, u: 11, pu: 9, bids: [["100", "2"]] }));
    book.onDiff(diff({ U: 13, u: 14, pu: 12, bids: [["100", "9"]] }));
    const result = book.applySnapshot(10, [["100", "1"]], [["101", "1"]]);
    expect(result).toEqual({ type: "gap", reason: "sequence" });
    expect(book.qty("bid", "100")).toBe(2);
    expect(book.synced).toBe(false);
  });

  it("clears the book on reconnect and only trusts a new snapshot", () => {
    const book = new FuturesDepthBook(0.1);
    book.applySnapshot(10, [["100", "1"]], [["101", "4"]]);
    book.onDiff(diff({ U: 10, u: 11, pu: 9, bids: [["100", "5"]] }));
    expect(book.qty("bid", "100")).toBe(5);

    book.reconnect();
    expect(book.synced).toBe(false);
    expect(book.qty("bid", "100")).toBe(0);
    expect(book.qty("ask", "101")).toBe(0);
    expect(book.onDiff(diff({ U: 11, u: 12, pu: 11, bids: [["100", "9"]] })).type).toBe("buffered");
    expect(book.qty("bid", "100")).toBe(0);

    const replaced = book.applySnapshot(20, [["100", "3"]], [["101", "4"]]);
    expect(replaced).toEqual({ type: "snapshot", bridged: false });
    expect(book.qty("bid", "100")).toBe(3);
    expect(book.qty("ask", "101")).toBe(4);
    expect(book.synced).toBe(true);
  });

  it("applies a post-reconnect buffer when the new snapshot is bridged by it", () => {
    const book = new FuturesDepthBook(0.1);
    book.applySnapshot(10, [["100", "1"]], [["101", "1"]]);
    book.reconnect();
    book.onDiff(diff({ U: 20, u: 21, pu: 19, bids: [["100", "8"]] }));
    const result = book.applySnapshot(20, [["100", "1"]], [["102", "2"]]);
    expect(result).toEqual({ type: "snapshot", bridged: true });
    expect(book.qty("bid", "100")).toBe(8);
    expect(book.qty("ask", "102")).toBe(2);
    expect(book.updateId).toBe(21);
  });

  it("reports buffer overflow instead of applying an unbounded queue", () => {
    const book = new FuturesDepthBook(0.1);
    for (let i = 0; i < 5_000; i++) {
      expect(book.onDiff(diff({ U: i, u: i, pu: i - 1 })).type).toBe("buffered");
    }
    expect(book.onDiff(diff({ U: 5000, u: 5000, pu: 4999 }))).toEqual({
      type: "gap",
      reason: "overflow",
    });
    expect(book.synced).toBe(false);
    const result = book.applySnapshot(6000, [["10", "1"]], [["11", "1"]]);
    expect(result).toEqual({ type: "snapshot", bridged: false });
    expect(book.qty("bid", "10")).toBe(1);
  });
});
