from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('naver', '0005_add_naver_tracking_product'),
    ]

    operations = [
        migrations.CreateModel(
            name='ItemScoutProduct',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=200)),
                ('url', models.URLField(max_length=500, unique=True)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={'db_table': 'itemscout_product'},
        ),
        migrations.CreateModel(
            name='ItemScoutRecord',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('today_purchase', models.IntegerField(default=0)),
                ('record_date', models.DateField()),
                ('recorded_at', models.DateTimeField(auto_now_add=True)),
                ('product', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='records', to='naver.itemscoutproduct')),
            ],
            options={'db_table': 'itemscout_record'},
        ),
        migrations.AddConstraint(
            model_name='itemscoutrecord',
            constraint=models.UniqueConstraint(fields=['product', 'record_date'], name='unique_product_date'),
        ),
        migrations.AddIndex(
            model_name='itemscoutrecord',
            index=models.Index(fields=['product', 'record_date'], name='itemscout_r_product_idx'),
        ),
    ]
