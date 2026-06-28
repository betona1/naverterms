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
    is_favorite = models.BooleanField(default=False, db_index=True)

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


class NaverTrackingProduct(models.Model):
    TYPE_CHOICES = [
        ('store', '스토어'),
        ('product_id', '상품ID'),
    ]
    target_type = models.CharField(max_length=20, choices=TYPE_CHOICES)
    target_value = models.CharField(max_length=200)
    display_name = models.CharField(max_length=200, blank=True, default='')
    product_name = models.CharField(max_length=500, blank=True, default='')
    product_image = models.URLField(max_length=500, blank=True, default='')
    product_url = models.CharField(max_length=500, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'naver_tracking_product'
        unique_together = [('target_type', 'target_value')]

    def __str__(self):
        return self.display_name or self.target_value


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
    auto_track = models.BooleanField(default=False)
    auto_track_times = models.JSONField(default=list, blank=True)  # ["09:00","13:00","18:00"]
    source_product_id = models.IntegerField(null=True, blank=True)
    source_product_name = models.CharField(max_length=500, blank=True, default='')
    matched_product_id = models.CharField(max_length=50, blank=True, default='')
    matched_product_name = models.CharField(max_length=500, blank=True, default='')
    product = models.ForeignKey(
        NaverTrackingProduct, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='targets'
    )
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


# ══════════════════════════════════════════
# 카테고리키워드 캐시
# ══════════════════════════════════════════

class ItemScoutProduct(models.Model):
    name = models.CharField(max_length=200)
    url = models.URLField(max_length=500, unique=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'itemscout_product'

    def __str__(self):
        return self.name


class ItemScoutRecord(models.Model):
    product = models.ForeignKey(ItemScoutProduct, on_delete=models.CASCADE, related_name='records')
    today_purchase = models.IntegerField(default=0)
    record_date = models.DateField()
    recorded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'itemscout_record'
        unique_together = [('product', 'record_date')]
        indexes = [
            models.Index(fields=['product', 'record_date']),
        ]


class CategoryKeywordCache(models.Model):
    """카테고리별 TOP 500 키워드 캐시 (DataLab 결과)"""
    cid = models.CharField(max_length=20)
    filter_key = models.CharField(max_length=50, default='__')  # "{age}_{gender}_{device}"
    ranks_json = models.JSONField(default=list)
    cached_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'naver_cat_keyword_cache'
        unique_together = [('cid', 'filter_key')]
        indexes = [
            models.Index(fields=['cid', 'filter_key']),
        ]


class KeywordEnrichCache(models.Model):
    """키워드별 검색량/상품수 캐시"""
    keyword = models.CharField(max_length=200, unique=True, db_index=True)
    monthly_pc_qc = models.IntegerField(default=0)
    monthly_mobile_qc = models.IntegerField(default=0)
    comp_idx = models.CharField(max_length=20, default='')
    product_count = models.IntegerField(default=0)
    category_name = models.CharField(max_length=500, default='')
    cached_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'naver_keyword_enrich_cache'


class NaverCrawlLog(models.Model):
    """수집 로그 — 확장프로그램 진행 메시지 DB 저장"""
    LOG_TYPES = [
        ('info', 'info'), ('success', 'success'), ('error', 'error'),
        ('progress', 'progress'), ('tab', 'tab'), ('captcha', 'captcha'),
    ]
    timestamp = models.DateTimeField(auto_now_add=True, db_index=True)
    type = models.CharField(max_length=20, default='info')
    message = models.TextField()
    keyword = models.CharField(max_length=200, blank=True, default='')
    session_id = models.CharField(max_length=64, blank=True, default='', db_index=True)

    class Meta:
        db_table = 'naver_crawl_log'
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['-timestamp']),
        ]


class NaverReport(models.Model):
    REPORT_TYPES = [
        ('monthly', '월간보고서'),
        ('analysis', '분석'),
    ]
    title = models.CharField(max_length=300)
    content = models.TextField()
    report_type = models.CharField(max_length=50, choices=REPORT_TYPES, default='monthly')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'naver_report'
        ordering = ['-created_at']

    def __str__(self):
        return self.title


# ══════════════════════════════════════════
# 구매수 추적
# ══════════════════════════════════════════

class NaverPurchaseTarget(models.Model):
    """구매수 추적 대상 상품"""
    nv_mid = models.CharField(max_length=50, unique=True, db_index=True)
    product_name = models.CharField(max_length=500)
    store_name = models.CharField(max_length=200, blank=True, default='')
    image_url = models.URLField(max_length=500, blank=True, default='')
    category = models.CharField(max_length=500, blank=True, default='')
    source_keyword = models.CharField(max_length=200, blank=True, default='')
    source_rank = models.IntegerField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    auto_track = models.BooleanField(default=False)
    auto_track_time = models.CharField(max_length=10, blank=True, default='09:00')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'naver_purchase_target'

    def __str__(self):
        return f'{self.product_name} ({self.nv_mid})'


class NaverPurchaseHistory(models.Model):
    """구매수 추적 이력"""
    target = models.ForeignKey(NaverPurchaseTarget, on_delete=models.CASCADE, related_name='history')
    purchase_count = models.IntegerField(null=True, blank=True)
    review_count = models.IntegerField(null=True, blank=True)
    keep_count = models.IntegerField(null=True, blank=True)
    price = models.IntegerField(null=True, blank=True)
    crawl_success = models.BooleanField(default=True)
    error_message = models.CharField(max_length=500, blank=True, default='')
    tracked_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'naver_purchase_history'
        indexes = [
            models.Index(fields=['target', 'tracked_at']),
        ]


# ══════════════════════════════════════════
# 동의어 (키워드별)
# ══════════════════════════════════════════

class NaverSynonym(models.Model):
    SOURCE_CHOICES = [
        ('naver_dict', '네이버사전'),
        ('autocomplete', '자동완성'),
        ('manual', '직접입력'),
    ]
    keyword = models.ForeignKey(NaverKeyword, on_delete=models.CASCADE, related_name='synonyms')
    word = models.CharField(max_length=200)
    source = models.CharField(max_length=20, choices=SOURCE_CHOICES, default='manual')
    is_confirmed = models.BooleanField(null=True, blank=True)  # True=동의어, False=아님, null=미확정
    verification_score = models.FloatField(null=True, blank=True)
    verification_data = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'naver_synonym'
        unique_together = [('keyword', 'word')]
        indexes = [
            models.Index(fields=['keyword', 'is_confirmed']),
        ]

    def __str__(self):
        return f'{self.keyword.keyword} ↔ {self.word}'
