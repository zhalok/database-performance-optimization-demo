#!/usr/bin/env python3
"""
pg_btree_parser.py

Parses a raw PostgreSQL B-tree index file (a .idx relfilenode file, or any
segment of one) directly from disk and dumps every page as human-readable
text: the generic page header, the btree "special space" (BTPageOpaqueData),
and every item (key + child pointer, or key + TID) stored on the page.

This reads the file byte-for-byte -- no running Postgres instance or
pageinspect extension required. Point it at the file returned by:

    SELECT pg_relation_filepath('your_index_name');

Usage:
    python3 pg_btree_parser.py /path/to/relfilenode [--page N] [--max-pages N]

Notes / limitations:
  - Assumes standard 8192-byte pages (Postgres default; check your build's
    BLCKSZ if it was compiled with a non-default page size).
  - Decodes item *pointers* (offset/length/flags) and, where possible, the
    raw key bytes and downlink/TID for each item. It does NOT know your
    index's column type(s), so key bytes are shown as hex plus a best-effort
    int64 interpretation -- decode further yourself if you know the type.
  - Only reads btree indexes (bt_metap-style metapage on page 0). Heap files
    and other index AMs (hash, gin, gist, brin) use different special-space
    layouts and are not handled here.
"""

import struct
import sys
import argparse

PAGE_SIZE = 8192

# ---- Generic PageHeaderData (24 bytes) --------------------------------
# struct PageHeaderData {
#   PageXLogRecPtr pd_lsn;      // 8 bytes (xlogid uint32 + xrecoff uint32)
#   uint16 pd_checksum;
#   uint16 pd_flags;
#   uint16 pd_lower;
#   uint16 pd_upper;
#   uint16 pd_special;
#   uint16 pd_pagesize_version; // pagesize (upper bits) | version (low 4 bits)
#   TransactionId pd_prune_xid; // 4 bytes
# };
PAGE_HEADER_FMT = "<IIHHHHHHI"
PAGE_HEADER_SIZE = struct.calcsize(PAGE_HEADER_FMT)  # 24

# ---- ItemIdData (4 bytes, bitfields) -----------------------------------
# lp_off:15, lp_flags:2, lp_len:15  packed into a uint32 (little-endian)
ITEMID_FMT = "<I"
ITEMID_SIZE = 4

LP_UNUSED = 0
LP_NORMAL = 1
LP_REDIRECT = 2
LP_DEAD = 3
LP_FLAGS = {LP_UNUSED: "UNUSED", LP_NORMAL: "NORMAL",
            LP_REDIRECT: "REDIRECT", LP_DEAD: "DEAD"}

# ---- BTPageOpaqueData (special space, 16 bytes) ------------------------
# struct BTPageOpaqueData {
#   BlockNumber btpo_prev;   // uint32
#   BlockNumber btpo_next;   // uint32
#   union { uint32 level; uint32 xact; } btpo;  // uint32
#   uint16 btpo_flags;
#   uint16 btpo_cycleid;
# };
BT_OPAQUE_FMT = "<IIIHH"
BT_OPAQUE_SIZE = struct.calcsize(BT_OPAQUE_FMT)  # 16

BTP_LEAF = 1 << 0
BTP_ROOT = 1 << 1
BTP_DELETED = 1 << 2
BTP_META = 1 << 3
BTP_HALF_DEAD = 1 << 4
BTP_SPLIT_END = 1 << 5
BTP_HAS_GARBAGE = 1 << 6
BTP_INCOMPLETE_SPLIT = 1 << 7

# ---- BTMetaPageData (lives inside page 0's item area / special space,
#      after the generic header) ----------------------------------------
# struct BTMetaPageData {
#   uint32 btm_magic;
#   uint32 btm_version;
#   BlockNumber btm_root;
#   uint32 btm_level;
#   BlockNumber btm_fastroot;
#   uint32 btm_fastlevel;
#   ... (newer fields for deduplication in PG 12+, omitted here)
# };
BT_META_FMT = "<IIIIII"
BT_META_SIZE = struct.calcsize(BT_META_FMT)  # 24
BTREE_METAPAGE_MAGIC = 0x00053162


def read_page(f, page_no):
    f.seek(page_no * PAGE_SIZE)
    data = f.read(PAGE_SIZE)
    if len(data) < PAGE_SIZE:
        return None
    return data


def parse_page_header(data):
    (lsn_hi, lsn_lo, checksum, flags, lower, upper,
     special, pagesize_version, prune_xid) = struct.unpack(
        PAGE_HEADER_FMT, data[:PAGE_HEADER_SIZE])
    pagesize = pagesize_version & 0xFF00
    version = pagesize_version & 0x000F
    return {
        "lsn": f"{lsn_hi:X}/{lsn_lo:X}",
        "checksum": checksum,
        "flags": flags,
        "lower": lower,
        "upper": upper,
        "special": special,
        "pagesize": pagesize,
        "version": version,
        "prune_xid": prune_xid,
    }


def parse_item_ids(data, lower):
    items = []
    n = (lower - PAGE_HEADER_SIZE) // ITEMID_SIZE
    for i in range(n):
        off = PAGE_HEADER_SIZE + i * ITEMID_SIZE
        (raw,) = struct.unpack(ITEMID_FMT, data[off:off + ITEMID_SIZE])
        lp_off = raw & 0x7FFF
        lp_flags = (raw >> 15) & 0x3
        lp_len = (raw >> 17) & 0x7FFF
        items.append({
            "itemid": i + 1,
            "lp_off": lp_off,
            "lp_flags": LP_FLAGS.get(lp_flags, str(lp_flags)),
            "lp_len": lp_len,
        })
    return items


def parse_bt_opaque(data, special_off):
    if special_off >= PAGE_SIZE:
        return None
    chunk = data[special_off:special_off + BT_OPAQUE_SIZE]
    if len(chunk) < BT_OPAQUE_SIZE:
        return None
    prev, next_, level_or_xact, flags, cycleid = struct.unpack(
        BT_OPAQUE_FMT, chunk)
    flag_names = []
    if flags & BTP_LEAF:
        flag_names.append("LEAF")
    if flags & BTP_ROOT:
        flag_names.append("ROOT")
    if flags & BTP_DELETED:
        flag_names.append("DELETED")
    if flags & BTP_META:
        flag_names.append("META")
    if flags & BTP_HALF_DEAD:
        flag_names.append("HALF_DEAD")
    if flags & BTP_SPLIT_END:
        flag_names.append("SPLIT_END")
    if flags & BTP_HAS_GARBAGE:
        flag_names.append("HAS_GARBAGE")
    if flags & BTP_INCOMPLETE_SPLIT:
        flag_names.append("INCOMPLETE_SPLIT")
    return {
        "btpo_prev": prev,
        "btpo_next": next_,
        "level_or_xact": level_or_xact,
        "flags_raw": flags,
        "flags": flag_names or ["(none)"],
        "cycleid": cycleid,
    }


def parse_bt_metapage(data):
    (magic, version, root, level, fastroot, fastlevel) = struct.unpack(
        BT_META_FMT, data[PAGE_HEADER_SIZE:PAGE_HEADER_SIZE + BT_META_SIZE])
    return {
        "magic": hex(magic),
        "magic_ok": magic == BTREE_METAPAGE_MAGIC,
        "version": version,
        "root": root,
        "level": level,
        "fastroot": fastroot,
        "fastlevel": fastlevel,
    }


def parse_item_tuple(data, item, is_leaf, is_meta_or_ignore):
    """
    Best-effort decode of one index tuple:
      IndexTupleData header (8 bytes): t_tid (6 bytes: block(4)+offset(2)),
      t_info (2 bytes: size in low 13 bits + flags in high 3 bits).
    After the 8-byte header comes the key data (nulls bitmap if any,
    then attribute bytes) -- we don't know the type, so we show raw hex
    and a best-effort int64 if the remaining length looks like 8 bytes.
    """
    off, length = item["lp_off"], item["lp_len"]
    if length < 8 or off + length > PAGE_SIZE:
        return {"error": f"item too short or out of range (len={length})"}
    chunk = data[off:off + length]
    block, tid_off_info = struct.unpack("<IH", chunk[0:6])
    t_info = struct.unpack("<H", chunk[6:8])[0]
    tuple_size = t_info & 0x1FFF
    key_bytes = chunk[8:length]

    result = {
        "tid_block": block,
        "tid_offset": tid_off_info,
        "t_info_size": tuple_size,
        "key_bytes_hex": key_bytes.hex(),
    }
    if len(key_bytes) == 8:
        result["key_as_int64_le"] = struct.unpack("<q", key_bytes)[0]
    return result


def dump_page(f, page_no, verbose_items=True):
    data = read_page(f, page_no)
    if data is None:
        print(f"[page {page_no}] -- EOF / short read, stopping")
        return False

    print(f"\n{'=' * 70}")
    print(f"PAGE {page_no}  (file offset {page_no * PAGE_SIZE})")
    print(f"{'=' * 70}")

    hdr = parse_page_header(data)
    print(f"  pd_lsn              : {hdr['lsn']}")
    print(f"  pd_checksum         : {hdr['checksum']}")
    print(f"  pd_flags            : {hdr['flags']}")
    print(f"  pd_lower            : {hdr['lower']}  (end of item pointers)")
    print(f"  pd_upper            : {hdr['upper']}  (start of tuple data)")
    print(f"  pd_special          : {hdr['special']}  (start of special space)")
    print(f"  pagesize/version    : {hdr['pagesize']} / {hdr['version']}")
    print(f"  pd_prune_xid        : {hdr['prune_xid']}")
    free_space = hdr['upper'] - hdr['lower']
    print(f"  free space          : {free_space} bytes")

    if page_no == 0:
        meta = parse_bt_metapage(data)
        print(f"\n  -- BTMetaPageData (this is the index metapage) --")
        print(f"  magic               : {meta['magic']}  (expected 0x53162: {meta['magic_ok']})")
        print(f"  version             : {meta['version']}")
        print(f"  root page           : {meta['root']}")
        print(f"  tree level (height) : {meta['level']}")
        print(f"  fastroot page       : {meta['fastroot']}")
        print(f"  fastroot level      : {meta['fastlevel']}")
        return True

    opaque = parse_bt_opaque(data, hdr["special"])
    if opaque:
        print(f"\n  -- BTPageOpaqueData (special space) --")
        print(f"  btpo_prev           : {opaque['btpo_prev']}")
        print(f"  btpo_next           : {opaque['btpo_next']}")
        print(f"  level               : {opaque['level_or_xact']}")
        print(f"  flags               : {', '.join(opaque['flags'])} (raw={opaque['flags_raw']})")
        is_leaf = bool(opaque['flags_raw'] & BTP_LEAF)
        is_meta = bool(opaque['flags_raw'] & BTP_META)
    else:
        is_leaf, is_meta = True, False

    items = parse_item_ids(data, hdr["lower"])
    print(f"\n  -- Items ({len(items)}) --")
    if not verbose_items:
        for it in items:
            print(f"  [{it['itemid']:3d}] off={it['lp_off']:5d} "
                  f"len={it['lp_len']:4d} flags={it['lp_flags']}")
        return True

    for it in items:
        if it["lp_flags"] != "NORMAL":
            print(f"  [{it['itemid']:3d}] flags={it['lp_flags']} (skipped, no tuple data)")
            continue
        tup = parse_item_tuple(data, it, is_leaf, is_meta)
        if "error" in tup:
            print(f"  [{it['itemid']:3d}] off={it['lp_off']:5d} len={it['lp_len']:4d}  ERROR: {tup['error']}")
            continue
        if is_leaf:
            print(f"  [{it['itemid']:3d}] key_hex={tup['key_bytes_hex']:<24} "
                  f"key_i64={tup.get('key_as_int64_le', '?'):<12} "
                  f"-> heap TID=({tup['tid_block']},{tup['tid_offset']})")
        else:
            # In internal pages the "tid_block" field doubles as the
            # downlink (child page number); offset is typically 0xFFFF.
            print(f"  [{it['itemid']:3d}] key_hex={tup['key_bytes_hex']:<24} "
                  f"key_i64={tup.get('key_as_int64_le', '?'):<12} "
                  f"-> child page={tup['tid_block']}")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("filepath", help="path to the index relfilenode segment")
    ap.add_argument("--page", type=int, default=None,
                     help="dump only this page number")
    ap.add_argument("--max-pages", type=int, default=20,
                     help="max pages to dump when walking the whole file (default 20)")
    ap.add_argument("--brief", action="store_true",
                     help="show item pointers only, not decoded key/TID")
    args = ap.parse_args()

    with open(args.filepath, "rb") as f:
        if args.page is not None:
            dump_page(f, args.page, verbose_items=not args.brief)
            return
        page_no = 0
        while page_no < args.max_pages:
            ok = dump_page(f, page_no, verbose_items=not args.brief)
            if not ok:
                break
            page_no += 1
        else:
            print(f"\n[stopped after {args.max_pages} pages -- use --max-pages to see more]")


if __name__ == "__main__":
    main()