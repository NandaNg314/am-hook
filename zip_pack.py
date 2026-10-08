import sys
import os
import zipfile

def pack_folder(out_zip, src_dir):
    with zipfile.ZipFile(out_zip, 'w', compression=zipfile.ZIP_STORED) as zf:
        for name in sorted(os.listdir(src_dir)):
            p = os.path.join(src_dir, name)
            if os.path.isfile(p):
                # Write file with explicit UTF-8 flag ensuring Windows Explorer compatibility
                zf.write(p, arcname=name)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(1)
    pack_folder(sys.argv[1], sys.argv[2])
