"""
오너클랜 ↔ 스마트스토어 상태 자동 동기화.

오너클랜 sale_status와 스마트스토어 status_type 불일치 시
네이버 커머스 API로 상태 변경 + 양쪽 로그 기록.

crontab: 0 * * * * (매시 정각)

사용:
  python3 manage.py sync_ownerclan_status               # 전체 (activate + suspend)
  python3 manage.py sync_ownerclan_status --activate     # 품절→판매중만
  python3 manage.py sync_ownerclan_status --suspend      # 판매중→품절만
  python3 manage.py sync_ownerclan_status --dry-run      # 미리보기 (DB 변경 없음)
"""
from django.core.management.base import BaseCommand
from ownerclan.ownerclan_product_service import sync_status_preview, sync_status_execute


class Command(BaseCommand):
    help = '오너클랜 ↔ 스마트스토어 상태 동기화 (매시간 cron 실행)'

    def add_arguments(self, parser):
        parser.add_argument('--activate', action='store_true',
                            help='품절→판매중 복원만 실행')
        parser.add_argument('--suspend', action='store_true',
                            help='판매중→품절 처리만 실행')
        parser.add_argument('--dry-run', action='store_true',
                            help='DB/API 변경 없이 미리보기')

    def handle(self, *args, **options):
        dry_run = options.get('dry_run', False)

        if options.get('activate'):
            mode = 'activate'
        elif options.get('suspend'):
            mode = 'suspend'
        else:
            mode = 'all'

        # 미리보기
        preview = sync_status_preview()
        self.stdout.write('오너클랜↔스마트스토어 상태 동기화')
        self.stdout.write('━' * 40)
        self.stdout.write(f'판매중→품절 대상: {preview["to_soldout"]}개 (품절) + {preview["to_discontinued"]}개 (단종)')
        self.stdout.write(f'품절→판매중 대상: {preview["to_activate_total"]}개 '
                          f'(SUSPENSION {preview["to_activate_suspension"]}개, OUTOFSTOCK {preview["to_activate_outofstock"]}개)')
        self.stdout.write(f'동기화 대상 합계: {preview["total_sync"]}개')
        self.stdout.write('━' * 40)

        if preview['total_sync'] == 0:
            self.stdout.write(self.style.SUCCESS('불일치 없음 — 동기화 불필요'))
            return

        if dry_run:
            self.stdout.write(self.style.WARNING('DRY-RUN 모드 — 실제 변경 없음'))
            return

        # 실행
        self.stdout.write(f'동기화 실행 (mode={mode})...')
        result = sync_status_execute(mode=mode, source='cron')

        self.stdout.write('━' * 40)
        self.stdout.write(f'성공: {result["success"]}건')
        self.stdout.write(f'스킵: {result["skipped"]}건')
        self.stdout.write(f'실패: {result["fail"]}건')
        self.stdout.write(f'소요: {result.get("elapsed", 0)}초')

        detail = result.get('detail', {})
        self.stdout.write(f'로그 기록: {detail.get("logged_changes", 0)}건 (양쪽)')

        if result['errors']:
            self.stdout.write(self.style.WARNING(f'에러 목록 (최대 10건):'))
            for err in result['errors'][:10]:
                self.stdout.write(f'  {err["product_code"]}: {err["error"]}')

        if result['skipped_items']:
            self.stdout.write(f'스킵 상세 (최대 10건):')
            for item in result['skipped_items'][:10]:
                self.stdout.write(f'  {item["product_code"]}: {item["status"]} ({item.get("store", "")})')

        self.stdout.write(self.style.SUCCESS('동기화 완료'))
