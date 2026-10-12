from database import DBmanage
from runtime_settings import database_path


class category:
    def __init__(self,payment:int):
        self.payment_ac = payment


    def Data_classification(self,key, *, connection=None, record_unknown=True):
        path = database_path()
        DB_for_Category = DBmanage(path)
        shop_name = None
        main_category = None
        sub_category = None
        if connection is None:
            DB_for_Category.connect_db(path)
            result = DB_for_Category.R_for_ShopName(key)
        else:
            # Import previews reuse the mail lookup without opening or writing the live database.
            result = connection.execute(
                "SELECT ShopName,MainCategory,SubCategory FROM ShopName WHERE key=?", (key,)
            ).fetchone()
        if result == None:
            unknow_key = key
            if record_unknown:
                DB_for_Category.C_for_UnknownShopName(key)
            main_category = "未分类"
            sub_category = "未分类"
            shop_name = unknow_key
        else:
            shop_name, main_category, sub_category = result

        return shop_name, main_category, sub_category
