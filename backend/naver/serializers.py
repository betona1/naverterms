from rest_framework import serializers
from .models import (
    NaverKeyword, NaverSearchSnapshot, NaverTermAnalysis,
    NaverRankTarget, NaverRankHistory, NaverTrackingSchedule,
    NaverPurchaseTarget, NaverPurchaseHistory,
    NaverSynonym, NaverTrackingProduct,
)


class NaverKeywordSerializer(serializers.ModelSerializer):
    class Meta:
        model = NaverKeyword
        fields = '__all__'


class NaverSearchSnapshotSerializer(serializers.ModelSerializer):
    class Meta:
        model = NaverSearchSnapshot
        fields = '__all__'


class NaverTermAnalysisSerializer(serializers.ModelSerializer):
    class Meta:
        model = NaverTermAnalysis
        fields = '__all__'


class NaverRankTargetSerializer(serializers.ModelSerializer):
    keyword_text = serializers.CharField(source='keyword.keyword', read_only=True)
    latest_rank = serializers.SerializerMethodField()
    rank_change = serializers.SerializerMethodField()

    class Meta:
        model = NaverRankTarget
        fields = '__all__'
        extra_fields = ['keyword_text', 'latest_rank', 'rank_change']

    def get_latest_rank(self, obj):
        latest = obj.history.order_by('-tracked_at').first()
        return latest.rank_position if latest else None

    def get_rank_change(self, obj):
        records = list(obj.history.order_by('-tracked_at')[:2])
        if len(records) < 2:
            return None
        curr = records[0].rank_position
        prev = records[1].rank_position
        if curr is None or prev is None:
            return None
        return prev - curr  # 양수 = 순위 상승


class NaverRankHistorySerializer(serializers.ModelSerializer):
    class Meta:
        model = NaverRankHistory
        fields = '__all__'


class NaverTrackingScheduleSerializer(serializers.ModelSerializer):
    class Meta:
        model = NaverTrackingSchedule
        fields = '__all__'


class NaverTrackingProductSerializer(serializers.ModelSerializer):
    class Meta:
        model = NaverTrackingProduct
        fields = '__all__'


class NaverPurchaseTargetSerializer(serializers.ModelSerializer):
    class Meta:
        model = NaverPurchaseTarget
        fields = '__all__'


class NaverPurchaseHistorySerializer(serializers.ModelSerializer):
    class Meta:
        model = NaverPurchaseHistory
        fields = '__all__'


class NaverSynonymSerializer(serializers.ModelSerializer):
    keyword_text = serializers.CharField(source='keyword.keyword', read_only=True)

    class Meta:
        model = NaverSynonym
        fields = '__all__'
        extra_fields = ['keyword_text']
