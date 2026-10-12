from database import DBmanage
from runtime_settings import database_path


class category:
    def __init__(self,payment:int):
        self.payment_ac = payment


    def Data_classification(self,key):
        path = database_path()
        DB_for_Category = DBmanage(path)
        DB_for_Category.connect_db(path)
        shop_name = None
        main_category = None
        sub_category = None
        result = DB_for_Category.R_for_ShopName(key)
        if result == None:
            unknow_key = key
            DB_for_Category.C_for_UnknownShopName(key)
            main_category = "未分类"
            sub_category = "未分类"
            shop_name = unknow_key
        else:
            shop_name, main_category, sub_category = DB_for_Category.R_get_ShopName(key)

        return shop_name, main_category, sub_category
