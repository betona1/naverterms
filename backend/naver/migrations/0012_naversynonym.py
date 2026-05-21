from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('naver', '0011_navercrawllog'),
    ]

    operations = [
        migrations.CreateModel(
            name='NaverSynonym',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('word', models.CharField(max_length=200)),
                ('source', models.CharField(
                    choices=[('naver_dict', '네이버사전'), ('autocomplete', '자동완성'), ('manual', '직접입력')],
                    default='manual', max_length=20)),
                ('is_confirmed', models.BooleanField(blank=True, null=True)),
                ('verification_score', models.FloatField(blank=True, null=True)),
                ('verification_data', models.JSONField(blank=True, default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('keyword', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='synonyms',
                    to='naver.naverkeyword')),
            ],
            options={
                'db_table': 'naver_synonym',
                'unique_together': {('keyword', 'word')},
                'indexes': [models.Index(fields=['keyword', 'is_confirmed'], name='naver_synon_keyword_idx')],
            },
        ),
    ]
