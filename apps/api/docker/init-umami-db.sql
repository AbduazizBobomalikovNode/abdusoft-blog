-- Postgres konteyneri birinchi marta ishga tushganda (`/docker-entrypoint-initdb.d`
-- ichidagi barcha `.sql` fayllar avtomatik bajariladi) `umami` uchun alohida
-- ma'lumotlar bazasini yaratadi — asosiy `blog` bazasidan ajratilgan holda,
-- lekin bir xil Postgres instansiyasida.
CREATE DATABASE umami;
