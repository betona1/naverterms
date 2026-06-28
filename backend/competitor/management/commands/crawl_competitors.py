from django.core.management.base import BaseCommand
from competitor.crawler import crawl_all


class Command(BaseCommand):
    help = '타사 상품 일괄 크롤링'

    def handle(self, *args, **options):
        self.stdout.write('타사 상품 크롤링 시작...')
        results = crawl_all()
        ok = sum(1 for r in results if r['ok'])
        fail = len(results) - ok
        self.stdout.write(f'완료: 성공 {ok}개 / 실패 {fail}개')
        for r in results:
            status = 'OK' if r['ok'] else 'FAIL'
            self.stdout.write(f'  [{status}] {r["url"]} — {r["detail"]}')
