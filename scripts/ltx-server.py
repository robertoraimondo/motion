import runpy
import sys
from pathlib import Path

backend = Path(r"C:\Users\Roy\AppData\Local\Programs\LTX Desktop\resources\backend")
sys.path.insert(0, str(backend))
runpy.run_path(str(backend / "ltx2_server.py"), run_name="__main__")