from django.db import models


class CompetitorProduct(models.Model):
    url = models.URLField(max_length=500, unique=True)
    product_no = models.CharField(max_length=50, blank=True, default='')
    store_alias = models.CharField(max_length=200, blank=True, default='')
    product_name = models.CharField(max_length=500, blank=True, default='')
    track_keyword = models.CharField(max_length=200, blank=True, default='')
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_crawled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'competitor_product'

    def __str__(self):
        return self.product_name or self.url


class CompetitorSnapshot(models.Model):
    product = models.ForeignKey(CompetitorProduct, on_delete=models.CASCADE, related_name='snapshots')
    price = models.IntegerField(null=True, blank=True)
    review_count = models.IntegerField(null=True, blank=True)
    total_stock = models.IntegerField(null=True, blank=True)
    options = models.JSONField(default=list)  # [{name, stock}] — 확장프로그램 수집
    rank_position = models.IntegerField(null=True, blank=True)
    purchase_count = models.BigIntegerField(null=True, blank=True)       # 누적 구매수
    recent_purchase_count = models.IntegerField(null=True, blank=True)   # 오늘 구매수 (recentPurchaseCount)
    estimated_sales = models.IntegerField(default=0)                     # 전 스냅샷 대비 purchaseCount 증가량
    naver_product_id = models.CharField(max_length=50, blank=True, default='')
    crawled_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'competitor_snapshot'
        indexes = [
            models.Index(fields=['product', 'crawled_at']),
        ]
