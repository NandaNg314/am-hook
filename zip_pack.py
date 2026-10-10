import sys
import os
import zipfile

def pack_folder(out_zip, src_dir, file_list=None):
    with zipfile.ZipFile(out_zip, 'w', compression=zipfile.ZIP_STORED) as zf:
        names = file_list if file_list is not None else os.listdir(src_dir)
        for name in sorted(names):
            p = os.path.join(src_dir, name)
            if os.path.isfile(p):
                # Write file with explicit UTF-8 flag ensuring Windows Explorer compatibility
                zf.write(p, arcname=name)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(1)
    # Optional: file list after output zip and src dir (e.g. split-volume packaging)
    file_list = sys.argv[3:] if len(sys.argv) > 3 else None
    pack_folder(sys.argv[1], sys.argv[2], file_list)
