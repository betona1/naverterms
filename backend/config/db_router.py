class NaverDbRouter:
    NAVER_MODELS = {'naverkeyword', 'naversearchsnapshot', 'navertermanalysis',
                    'naverranktarget', 'naverrankhistory', 'navertrackingschedule',
                    'categorykeywordcache', 'keywordenrichcache', 'naverreport'}

    def db_for_read(self, model, **hints):
        if model._meta.model_name in self.NAVER_MODELS:
            return 'naverdb'
        return None

    def db_for_write(self, model, **hints):
        if model._meta.model_name in self.NAVER_MODELS:
            return 'naverdb'
        return None

    def allow_relation(self, obj1, obj2, **hints):
        return True

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if app_label == 'naver':
            return db == 'naverdb'
        return db == 'default'
