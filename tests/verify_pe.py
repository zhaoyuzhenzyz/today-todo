import struct, sys, os

def read_pe_resources(path):
    """极简 PE 资源解析：返回 RT_ICON / RT_GROUP_ICON 条目数与图标数据长度"""
    with open(path, 'rb') as f:
        data = f.read()
    if data[:2] != b'MZ':
        return None
    e_lfanew = struct.unpack_from('<I', data, 0x3C)[0]
    if data[e_lfanew:e_lfanew+4] != b'PE\0\0':
        return None
    coff = e_lfanew + 4
    num_sections = struct.unpack_from('<H', data, coff + 2)[0]
    opt_size = struct.unpack_from('<H', data, coff + 16)[0]
    opt = coff + 20
    magic = struct.unpack_from('<H', data, opt)[0]
    pe32plus = magic == 0x20b
    dd_off = opt + (112 if pe32plus else 96)
    res_rva, res_size = struct.unpack_from('<II', data, dd_off + 2*8)
    if res_rva == 0:
        return {'error': 'no resource directory'}
    # section table
    sec_off = opt + opt_size
    sections = []
    for i in range(num_sections):
        base = sec_off + i*40
        name = data[base:base+8].rstrip(b'\0').decode('ascii', 'replace')
        vsize, vaddr, rawsize, rawptr = struct.unpack_from('<IIII', data, base + 8)
        sections.append((name, vaddr, vsize, rawptr, rawsize))
    def rva2off(rva):
        for name, vaddr, vsize, rawptr, rawsize in sections:
            if vaddr <= rva < vaddr + max(vsize, rawsize):
                return rawptr + (rva - vaddr)
        return None
    res_off = rva2off(res_rva)
    if res_off is None:
        return {'error': 'cannot map res rva'}

    def walk(off, depth, path):
        out = []
        if depth > 2:
            return out
        named, ids = struct.unpack_from('<HH', data, off + 12)
        count = named + ids
        for i in range(count):
            e = off + 16 + i*8
            nameid, target = struct.unpack_from('<II', data, e)
            is_dir = bool(target & 0x80000000)
            tgt = target & 0x7FFFFFFF
            ident = nameid if not (nameid & 0x80000000) else ('named')
            if is_dir:
                out += walk(res_off + tgt, depth+1, path + [ident])
            else:
                d_off = res_off + tgt
                data_rva, data_size, cp, _ = struct.unpack_from('<IIII', data, d_off)
                dfile = rva2off(data_rva)
                out.append({'path': path + [ident], 'size': data_size, 'off': dfile})
        return out

    entries = walk(res_off, 0, [])
    icons = [e for e in entries if e['path'] and e['path'][0] == 3]
    groups = [e for e in entries if e['path'] and e['path'][0] == 14]
    ver = [e for e in entries if e['path'] and e['path'][0] == 16]
    return {
        'icon_count': len(icons),
        'icon_sizes': sorted([e['size'] for e in icons]),
        'group_count': len(groups),
        'version_count': len(ver),
        'version_size': ver[0]['size'] if ver else 0,
    }

def get_version_string(path):
    """从资源里粗略搜 UTF-16 版本号字符串"""
    with open(path, 'rb') as f:
        data = f.read()
    import re
    hits = re.findall(rb'(?:[0-9]\x00){1,2}\.\x00(?:[0-9]\x00){1,2}\.\x00(?:[0-9]\x00){1,2}', data)
    out = set()
    for h in hits[:40]:
        try:
            out.add(h.decode('utf-16-le'))
        except: pass
    return sorted(out)

import glob as _glob
_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'desktop-todo')

files = [
    os.path.join(_ROOT, 'dist', 'win-unpacked', '今日待办.exe'),
    os.path.join(_ROOT, 'dist', '今日待办-安装程序-1.0.2.exe'),
    os.path.join(_ROOT, 'dist', '今日待办-免安装-1.0.2.exe'),
]
for f in files:
    if not os.path.exists(f):
        print(f"MISSING {f}")
        continue
    r = read_pe_resources(f)
    print(f"\n=== {os.path.basename(f)} ({os.path.getsize(f):,} bytes) ===")
    if r is None:
        print("  不是有效 PE")
        continue
    for k, v in r.items():
        print(f"  {k}: {v}")
    print(f"  版本串样本: {get_version_string(f)[:8]}")
