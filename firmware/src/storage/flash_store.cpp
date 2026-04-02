/**
 * Persistent flash storage — sector 7 (0x080E0000, 128 KB).
 *
 * Uses HAL flash driver to erase/program. STM32H7 programs in 32-byte
 * "flash words" (FLASH_TYPEPROGRAM_FLASHWORD), so the settings struct
 * is padded to 256 bytes (8 flash words).
 *
 * CRC-32 uses a small 256-entry lookup table (1 KB ROM).
 */

#include "flash_store.h"
#include "spinel_props.h"
#include "stm32h7xx_hal.h"

#include <cstdio>
#include <cstring>

/* -----------------------------------------------------------------------
 * Software CRC-32 (same polynomial as zlib / Ethernet)
 * ----------------------------------------------------------------------- */
static const uint32_t crc32_table[256] = {
    0x00000000, 0x77073096, 0xEE0E612C, 0x990951BA, 0x076DC419, 0x706AF48F, 0xE963A535, 0x9E6495A3, 0x0EDB8832,
    0x79DCB8A4, 0xE0D5E91B, 0x97D2D988, 0x09B64C2B, 0x7EB17CBF, 0xE7B82D09, 0x90BF1D9F, 0x1DB71064, 0x6AB020F2,
    0xF3B97148, 0x84BE41DE, 0x1ADAD47D, 0x6DDDE4EB, 0xF4D4B551, 0x83D385C7, 0x136C9856, 0x646BA8C0, 0xFD62F97A,
    0x8A65C9EC, 0x14015C4F, 0x63066CD9, 0xFA0F3D63, 0x8D080DF5, 0x3B6E20C8, 0x4C69105E, 0xD56041E4, 0xA2677172,
    0x3C03E4D1, 0x4B04D447, 0xD20D85FD, 0xA50AB56B, 0x35B5A8FA, 0x42B2986C, 0xDBBBC9D6, 0xACBCF940, 0x32D86CE3,
    0x45DF5C75, 0xDCD60DCF, 0xABD13D59, 0x26D930AC, 0x51DE003A, 0xC8D75180, 0xBFD06116, 0x21B4F6B5, 0x56B3C423,
    0xCFBA9599, 0xB8BDA50F, 0x2802B89E, 0x5F058808, 0xC60CD9B2, 0xB10BE924, 0x2F6F7C87, 0x58684C11, 0xC1611DAB,
    0xB6662D3D, 0x76DC4190, 0x01DB7106, 0x98D220BC, 0xEFD5102A, 0x71B18589, 0x06B6B51F, 0x9FBFE4A5, 0xE8B8D433,
    0x7807C9A2, 0x0F00F934, 0x9609A88E, 0xE10E9818, 0x7F6A0D6B, 0x086D3D2D, 0x91646C97, 0xE6635C01, 0x6B6B51F4,
    0x1C6C6162, 0x856530D8, 0xF262004E, 0x6C0695ED, 0x1B01A57B, 0x8208F4C1, 0xF50FC457, 0x65B0D9C6, 0x12B7E950,
    0x8BBEB8EA, 0xFCB9887C, 0x62DD1D7F, 0x15DA2D49, 0x8CD37CF3, 0xFBD44C65, 0x4DB26158, 0x3AB551CE, 0xA3BC0074,
    0xD4BB30E2, 0x4ADFA541, 0x3DD895D7, 0xA4D1C46D, 0xD3D6F4FB, 0x4369E96A, 0x346ED9FC, 0xAD678846, 0xDA60B8D0,
    0x44042D73, 0x33031DE5, 0xAA0A4C5F, 0xDD0D7822, 0x3B6E20C8, 0x4C69105E, 0xD56041E4, 0xA2677172, 0x3C03E4D1,
    0x4B04D447, 0xD20D85FD, 0xA50AB56B, 0x35B5A8FA, 0x42B2986C, 0xDBBBC9D6, 0xACBCF940, 0x32D86CE3, 0x45DF5C75,
    0xDCD60DCF, 0xABD13D59, 0x26D930AC, 0x51DE003A, 0xC8D75180, 0xBFD06116, 0x21B4F6B5, 0x56B3C423, 0xCFBA9599,
    0xB8BDA50F, 0x2802B89E, 0x5F058808, 0xC60CD9B2, 0xB10BE924, 0x2F6F7C87, 0x58684C11, 0xC1611DAB, 0xB6662D3D,
    0x76DC4190, 0x01DB7106, 0x98D220BC, 0xEFD5102A, 0x71B18589, 0x06B6B51F, 0x9FBFE4A5, 0xE8B8D433, 0x7807C9A2,
    0x0F00F934, 0x9609A88E, 0xE10E9818, 0x7F6A0D6B, 0x086D3D2D, 0x91646C97, 0xE6635C01, 0x6B6B51F4, 0x1C6C6162,
    0x856530D8, 0xF262004E, 0x6C0695ED, 0x1B01A57B, 0x8208F4C1, 0xF50FC457, 0x65B0D9C6, 0x12B7E950, 0x8BBEB8EA,
    0xFCB9887C, 0x62DD1D7F, 0x15DA2D49, 0x8CD37CF3, 0xFBD44C65, 0x4DB26158, 0x3AB551CE, 0xA3BC0074, 0xD4BB30E2,
    0x4ADFA541, 0x3DD895D7, 0xA4D1C46D, 0xD3D6F4FB, 0x4369E96A, 0x346ED9FC, 0xAD678846, 0xDA60B8D0, 0x44042D73,
    0x33031DE5, 0xAA0A4C5F, 0xDD0D7822, 0x9B64C2B0, 0xEC63F226, 0x756AA39C, 0x026D930A, 0x9C0906A9, 0xEB0E363F,
    0x72076785, 0x05005713, 0x95BF4A82, 0xE2B87A14, 0x7BB12BAE, 0x0CB61B38, 0x92D28E9B, 0xE5D5BE0D, 0x7CDCEFB7,
    0x0BDBDF21, 0x86D3D2D4, 0xF1D4E242, 0x68DDB3F6, 0x1FDA836E, 0x81BE16CD, 0xF6B9265B, 0x6FB077E1, 0x18B74777,
    0x88085AE6, 0xFF0F6B70, 0x66063BCA, 0x11010B5C, 0x8F659EFF, 0xF862AE69, 0x616BFFD3, 0x166CCF45, 0xA00AE278,
    0xD70DD2EE, 0x4E048354, 0x3903B3C2, 0xA7672661, 0xD06016F7, 0x4969474D, 0x3E6E77DB, 0xAE321404, 0xD9352435,
    0x4036342E, 0x17316E58, 0xA03694BF, 0xD7316E89, 0x4C34D633, 0x1B37E6A5, 0x6E6B5106, 0x196C6190, 0x8065302A,
    0xF762004E, 0x6906C2FE, 0x1E01F268, 0x8F0BBC72, 0xF80CE6E4, 0x68000743, 0x1F0F37D5, 0x860E6C6F, 0xF109FCF9,
    0x2EB40D81, 0x59B33D17, 0xC0BA6CAD, 0xB7BD5C3B,
};

static uint32_t calc_crc32(const uint8_t* data, size_t len)
{
    uint32_t crc = 0xFFFFFFFF;
    for (size_t i = 0; i < len; i++) {
        crc = (crc >> 8) ^ crc32_table[(crc ^ data[i]) & 0xFF];
    }
    return crc ^ 0xFFFFFFFF;
}

/* -----------------------------------------------------------------------
 * In-RAM copy of settings
 * ----------------------------------------------------------------------- */
static FlashSettings settings;

static void load_defaults(void)
{
    memset(&settings, 0, sizeof(settings));
    settings.magic = FLASH_STORE_MAGIC;
    settings.version = FLASH_STORE_VERSION;

    settings.known_count = 0;

    settings.thread_channel = LUTRON_THREAD_CHANNEL;
    settings.thread_panid = LUTRON_THREAD_PANID;
    memcpy(settings.thread_network_key, LUTRON_THREAD_MASTER_KEY, 16);
    memcpy(settings.thread_xpanid, LUTRON_THREAD_XPANID, 8);
}

/* -----------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------- */

void flash_store_init(void)
{
    /* Read settings from flash */
    const FlashSettings* stored = (const FlashSettings*)FLASH_STORE_ADDR;

    if (stored->magic != FLASH_STORE_MAGIC || stored->version != FLASH_STORE_VERSION) {
        printf("[flash] No valid settings (magic=0x%08lX ver=%u), loading defaults\r\n", (unsigned long)stored->magic,
               stored->version);
        load_defaults();
        return;
    }

    /* Verify CRC-32 over first 252 bytes */
    uint32_t computed = calc_crc32((const uint8_t*)stored, sizeof(FlashSettings) - sizeof(uint32_t));
    if (computed != stored->crc32) {
        printf("[flash] CRC mismatch (stored=0x%08lX computed=0x%08lX), loading defaults\r\n",
               (unsigned long)stored->crc32, (unsigned long)computed);
        load_defaults();
        return;
    }

    /* Valid — copy to RAM */
    memcpy(&settings, stored, sizeof(FlashSettings));
    printf("[flash] Settings loaded (ch=%u panid=0x%04X devices=%u)\r\n", settings.thread_channel,
           settings.thread_panid, settings.known_count);
}

bool flash_store_save(void)
{
    /* Update CRC before writing */
    settings.crc32 = calc_crc32((const uint8_t*)&settings, sizeof(FlashSettings) - sizeof(uint32_t));

    /* Unlock flash */
    HAL_FLASH_Unlock();

    /* Erase sector 7 */
    FLASH_EraseInitTypeDef erase;
    erase.TypeErase = FLASH_TYPEERASE_SECTORS;
    erase.Banks = FLASH_BANK_1;
    erase.Sector = FLASH_STORE_SECTOR;
    erase.NbSectors = 1;
    erase.VoltageRange = FLASH_VOLTAGE_RANGE_3; /* 2.7-3.6V */

    uint32_t sector_error = 0;
    HAL_StatusTypeDef status = HAL_FLASHEx_Erase(&erase, &sector_error);
    if (status != HAL_OK) {
        printf("[flash] Erase failed (status=%d sector_error=%lu)\r\n", status, (unsigned long)sector_error);
        HAL_FLASH_Lock();
        return false;
    }

    /* Program in 32-byte flash words.
     * sizeof(FlashSettings) = 256 = 8 flash words. */
    const uint8_t* src = (const uint8_t*)&settings;
    uint32_t addr = FLASH_STORE_ADDR;

    for (size_t offset = 0; offset < sizeof(FlashSettings); offset += 32) {
        status = HAL_FLASH_Program(FLASH_TYPEPROGRAM_FLASHWORD, addr + offset, (uint32_t)(uintptr_t)(src + offset));
        if (status != HAL_OK) {
            printf("[flash] Program failed at offset %u (status=%d)\r\n", (unsigned)offset, status);
            HAL_FLASH_Lock();
            return false;
        }
    }

    HAL_FLASH_Lock();

    /* Verify readback */
    if (memcmp((const void*)FLASH_STORE_ADDR, &settings, sizeof(FlashSettings)) != 0) {
        printf("[flash] Verify failed!\r\n");
        return false;
    }

    printf("[flash] Settings saved OK\r\n");
    return true;
}

const FlashSettings* flash_store_get(void)
{
    return &settings;
}

FlashSettings* flash_store_get_mut(void)
{
    return &settings;
}

void flash_store_print(void)
{
    printf("--- Stored Settings ---\r\n");
    printf("Thread channel: %u\r\n", settings.thread_channel);
    printf("Thread PAN ID:  0x%04X\r\n", settings.thread_panid);

    printf("Thread key:     ");
    for (int i = 0; i < 16; i++) printf("%02X", settings.thread_network_key[i]);
    printf("\r\n");

    printf("Thread XPANID:  ");
    for (int i = 0; i < 8; i++) printf("%02X", settings.thread_xpanid[i]);
    printf("\r\n");

    printf("Known devices:  %u\r\n", settings.known_count);
    for (uint8_t i = 0; i < settings.known_count && i < FLASH_STORE_MAX_DEVICES; i++) {
        printf("  [%u] %08lX\r\n", i, (unsigned long)settings.known_devices[i]);
    }
}
