import os, django, sys, time
sys.path.insert(0,'.'); os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings'); django.setup()
from django.db import connections
from smartstore import diagnosis_service as ds
LOG=open('/tmp/diag_test.log','w',buffering=1)
import smartstore.diagnosis_service as d
d._log=lambda m,_o=d._log: (LOG.write(m+'\n'),LOG.flush(),_o(m))[2] if False else (LOG.write(str(m)+'\n'),LOG.flush())
with connections['myproduct'].cursor() as c:
    c.execute("SELECT id,store_id,store_pw,store_name FROM smartstoreIdList WHERE store_name='행원만물상' LIMIT 1")
    pk,lid,pw,nm=c.fetchone()
LOG.write('start %s %s\n'%(lid,nm)); LOG.flush()
try:
    r=ds.collect_login(lid,pw,[nm],{nm:pk})
    LOG.write('RESULT %s\n'%r); LOG.flush()
except Exception as e:
    import traceback; LOG.write('EXC '+traceback.format_exc()[:500]+'\n'); LOG.flush()
LOG.write('=== DONE ===\n'); LOG.flush()
