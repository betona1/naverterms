from django.db import models


class NaverKeyword(models.Model):
    keyword = models.CharField(max_length=200, unique=True)
    term_count = models.IntegerField(default=0)
    terms = models.JSONField(default=list, blank=True)
    total_count = models.IntegerField(default=0)
    naverpay_count = models.IntegerField(default=0)
    price_compare_count = models.IntegerField(default=0)
    last_searched_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'naver_keyword'

    def __str__(self):
        return self.keyword


class NaverSearchSnapshot(models.Model):
    TAB_CHOICES = [
        ('total', '전체'),
        ('model', '가격비교'),
        ('checkout', '네이버페이'),
    ]
    keyword = models.ForeignKey(NaverKeyword, on_delete=models.CASCADE, related_name='snapshots')
    tab_type = models.CharField(max_length=20, choices=TAB_CHOICES)
    products = models.JSONField(default=list)
    total = models.IntegerField(default=0)
    collected_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'naver_search_snapshot'
        indexes = [
            models.Index(fields=['keyword', 'tab_type', 'collected_at']),
        ]


class NaverTermAnalysis(models.Model):
    keyword = models.ForeignKey(NaverKeyword, on_delete=models.CASCADE, related_name='analyses')
    term1 = models.CharField(max_length=100, blank=True, default='')
    term2 = models.CharField(max_length=100, blank=True, default='')
    term3 = models.CharField(max_length=100, blank=True, default='')
    term4 = models.CharField(max_length=100, blank=True, default='')
    order_weight = models.JSONField(default=dict, blank=True)
    position_weight = models.JSONField(default=dict, blank=True)
    name_weight = models.JSONField(default=dict, blank=True)
    part_weight = models.JSONField(default=dict, blank=True)
    category_priority = models.JSONField(default=dict, blank=True)
    analyzed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'naver_term_analysis'


class NaverRankTarget(models.Model):
    TYPE_CHOICES = [
        ('store', '스토어'),
        ('product_id', '상품ID'),
    ]
    keyword = models.ForeignKey(NaverKeyword, on_delete=models.CASCADE, related_name='rank_targets')
    target_type = models.CharField(max_length=20, choices=TYPE_CHOICES)
    target_value = models.CharField(max_length=200)
    display_name = models.CharField(max_length=200, blank=True, default='')
    is_active = models.BooleanField(default=True)
    source_product_id = models.IntegerField(null=True, blank=True)
    source_product_name = models.CharField(max_length=500, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'naver_rank_target'
        unique_together = [('keyword', 'target_type', 'target_value')]


class NaverRankHistory(models.Model):
    target = models.ForeignKey(NaverRankTarget, on_delete=models.CASCADE, related_name='history')
    rank_position = models.IntegerField(null=True, blank=True)
    tab_type = models.CharField(max_length=20, default='total')
    total_results = models.IntegerField(default=0)
    found_product_name = models.CharField(max_length=500, blank=True, default='')
    found_product_price = models.IntegerField(null=True, blank=True)
    found_review_count = models.IntegerField(null=True, blank=True)
    found_product_id = models.CharField(max_length=50, blank=True, default='')
    found_product_url = models.URLField(max_length=500, blank=True, default='')
    found_product_image = models.URLField(max_length=500, blank=True, default='')
    tracked_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'naver_rank_history'
        indexes = [
            models.Index(fields=['target', 'tracked_at']),
        ]


class NaverTrackingSchedule(models.Model):
    SCHEDULE_CHOICES = [
        ('daily', '매일'),
        ('interval', '간격'),
    ]
    name = models.CharField(max_length=100)
    target_ids = models.JSONField(default=list)
    schedule_type = models.CharField(max_length=20, choices=SCHEDULE_CHOICES)
    schedule_time = models.CharField(max_length=10, blank=True, default='')
    is_active = models.BooleanField(default=True)
    last_run_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'naver_tracking_schedule'
