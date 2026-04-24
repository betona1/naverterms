"""
자동 순위추적 management command.
auto_track=True이고 auto_track_times에 현재 시(HH:00)가 포함된 타겟만 실행.
times가 비어있으면 매 실행마다 추적 (하위호환).

crontab: 0 * * * * (매시 정각)
"""
from datetime import datetime
from django.core.management.base import BaseCommand
from naver.models import NaverRankTarget
from naver import services


class Command(BaseCommand):
    help = '자동추적(auto_track=True) 타겟의 순위를 조회합니다'

    def add_arguments(self, parser):
        parser.add_argument('--force', action='store_true', help='시간 체크 무시하고 전체 실행')

    def handle(self, *args, **options):
        now = datetime.now()
        current_hhmm = now.strftime('%H:00')
        force = options.get('force', False)

        targets = NaverRankTarget.objects.filter(is_active=True, auto_track=True)

        if not force:
            # auto_track_times가 비어있거나 현재 시간이 포함된 타겟만 필터
            target_ids = []
            for t in targets:
                times = t.auto_track_times or []
                if not times or current_hhmm in times:
                    target_ids.append(t.id)
        else:
            target_ids = list(targets.values_list('id', flat=True))

        if not target_ids:
            self.stdout.write(f'[{current_hhmm}] 실행 대상 없음')
            return

        self.stdout.write(f'[{current_hhmm}] 자동추적 시작: {len(target_ids)}개 타겟')
        try:
            result = services.run_rank_tracking(target_ids)
            tracked = result.get('tracked', 0)
            errors = result.get('errors', [])
            self.stdout.write(self.style.SUCCESS(f'완료: {tracked}개 추적, 에러 {len(errors)}개'))
            for err in errors:
                self.stderr.write(f'  에러: {err}')
        except Exception as e:
            self.stderr.write(self.style.ERROR(f'실행 실패: {e}'))
