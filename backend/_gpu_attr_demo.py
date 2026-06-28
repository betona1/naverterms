"""1건 GPU 멀티모달 속성분류 데모 — 상품명+이미지(썸네일)+상세 → 속성값 분류."""
import os, sys, json, base64, re
import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings'); django.setup()
from django.db import connections
import requests
from smartstore import thumbnail_vision_service as tv

STORE = 83
GPU = tv.GPU_HOSTS[0]

# 1) 미등록 속성 4+ 보유 상품 1건
with connections['myproduct'].cursor() as c:
    c.execute("""SELECT p.seller_management_code, p.origin_product_no, p.name, p.category_id,
        LEFT(p.detail_content,600)
        FROM smartstore_product p
        WHERE p.store_id=%s AND p.seller_management_code LIKE 'W%%'
          AND EXISTS (SELECT 1 FROM smartstore_product_missing_attrs m
                      WHERE m.seller_management_code=p.seller_management_code COLLATE utf8mb4_unicode_ci
                        AND m.store_id=p.store_id AND m.status='pending' AND m.candidate_count BETWEEN 2 AND 12)
        LIMIT 1""", [STORE])
    p = c.fetchone()

code, opno, name, cat, detail = p
leaf = cat.split('>')[-1] if cat else ''
detail_txt = re.sub(r'<[^>]+>', ' ', detail or '')[:400]
print(f'■ 상품: {code} (opno {opno})')
print(f'  상품명: {name}')
print(f'  카테고리(leaf): {leaf}')
print(f'  상세(텍스트): {detail_txt[:120]}...')

with connections['myproduct'].cursor() as c:
    c.execute("""SELECT attribute_seq, attribute_name, classification_type, candidate_values_json
        FROM smartstore_product_missing_attrs
        WHERE seller_management_code=%s AND store_id=%s AND status='pending'
          AND candidate_count BETWEEN 2 AND 12 LIMIT 8""", [code, STORE])
    attrs = []
    for aseq, aname, cls, cj in c.fetchall():
        attrs.append({'seq': aseq, 'name': aname, 'cls': cls, 'cands': json.loads(cj)})

print(f'  미등록 속성 {len(attrs)}개\n')

# 2) 이미지 — 네이버 커머스 API 대표이미지 + 상세이미지 (실제 등록 썸네일)
from smartstore import smartstore_product_service as sps
with connections['myproduct'].cursor() as c:
    c.execute("SELECT commerce_api_key, commerce_secret_key FROM smartstoreIdList WHERE id=%s", [STORE])
    ak, sk = c.fetchone()
token = sps._get_access_token(ak, sk)
det = requests.get(sps.NAVER_PRODUCT_DETAIL_URL.format(opno),
                   headers={'Authorization': f'Bearer {token}'}, timeout=20).json()
op = det.get('originProduct', {})
imgs = op.get('images', {}) or {}
rep = (imgs.get('representativeImage') or {}).get('url')
b64 = tv._dl_b64(rep) if rep else None
# 상세설명 보강
dc = (op.get('detailContent') or '')
detail_txt = (detail_txt + ' ' + re.sub(r'<[^>]+>', ' ', dc))[:500]
print(f'  이미지: {rep} ({"다운OK" if b64 else "실패"})\n')

# 3) GPU 멀티모달 분류 프롬프트
lines = [f'상품명: {name}', f'상세설명: {detail_txt}', '', '아래 각 속성에 대해, 상품명·상세·이미지를 보고 가장 정확한 후보 1개의 seq를 고르세요.',
         '확실하지 않으면 반드시 null. 추측 금지.', '', '[속성]']
for a in attrs:
    opts = ', '.join(f"{c['seq']}={c['text']}" for c in a['cands'])
    lines.append(f"- {a['name']} (seq={a['seq']}, {a['cls']}): {opts}")
lines.append('')
lines.append('각 속성의 seq(숫자)를 키로, 고른 후보의 seq(숫자)나 null을 값으로 하는 평면 JSON 하나만 출력.')
ex_a = attrs[0]
lines.append(f'예: {{"{ex_a["seq"]}": {ex_a["cands"][0]["seq"]}}}  (설명·코드펜스 금지)')
prompt = '\n'.join(lines)

payload = {'model': 'qwen2.5vl:7b',
           'messages': [{'role': 'user', 'content': prompt, 'images': [b64] if b64 else []}],
           'stream': False, 'options': {'temperature': 0.1, 'num_predict': 400}}
print('▶ GPU(qwen2.5vl) 멀티모달 분류 호출...')
r = requests.post(f'http://{GPU}:11434/api/chat', json=payload, timeout=120)
out = (r.json().get('message') or {}).get('content', '')
print('  원응답:', out[:300])

m = re.search(r'\{.*\}', out, re.S)
picked = json.loads(m.group(0)) if m else {}
print('\n■ 분류 결과:')
amap = {str(a['seq']): a for a in attrs}
for aseq, vseq in picked.items():
    a = amap.get(str(aseq))
    if not a:
        continue
    if vseq is None:
        print(f'  [{a["name"]}] → (판단보류/null)')
    else:
        vt = next((c['text'] for c in a['cands'] if str(c['seq']) == str(vseq)), '?')
        print(f'  [{a["name"]}] → {vt} (seq {vseq})')
