from rest_framework import serializers
from .models import CompetitorProduct, CompetitorSnapshot


class CompetitorSnapshotSerializer(serializers.ModelSerializer):
    class Meta:
        model = CompetitorSnapshot
        fields = ['id', 'price', 'review_count', 'total_stock', 'options',
                  'rank_position', 'purchase_count', 'recent_purchase_count',
                  'estimated_sales', 'naver_product_id', 'crawled_at']


class CompetitorProductSerializer(serializers.ModelSerializer):
    latest_snapshot = serializers.SerializerMethodField()

    class Meta:
        model = CompetitorProduct
        fields = ['id', 'url', 'product_no', 'store_alias', 'product_name',
                  'track_keyword', 'is_active', 'created_at', 'last_crawled_at', 'latest_snapshot']

    def get_latest_snapshot(self, obj):
        snap = obj.snapshots.order_by('-crawled_at').first()
        if snap:
            return CompetitorSnapshotSerializer(snap).data
        return None
