#ifndef LWIPOPTS_H
#define LWIPOPTS_H

/* -----------------------------------------------------------------------
 * lwIP options for STM32H723 + FreeRTOS
 * ----------------------------------------------------------------------- */

/* Use FreeRTOS */
#define NO_SYS                          0
#define LWIP_SOCKET                     0
#define LWIP_NETCONN                    1

/* Memory configuration */
#define MEM_ALIGNMENT                   4
#define MEM_SIZE                        (16 * 1024)
#define MEMP_NUM_PBUF                   32
/* Small frames (≤60 B) always fit in one pbuf — skip chain handling on TX. */
#define LWIP_NETIF_TX_SINGLE_PBUF       1
#define MEMP_NUM_TCP_PCB                5
#define MEMP_NUM_TCP_PCB_LISTEN         2
#define MEMP_NUM_TCP_SEG                16
#define MEMP_NUM_NETBUF                 8
#define MEMP_NUM_NETCONN                8
#define PBUF_POOL_SIZE                  16
#define PBUF_POOL_BUFSIZE              1524

/* TCP configuration */
#define LWIP_TCP                        1
#define TCP_MSS                         1460
#define TCP_SND_BUF                     (4 * TCP_MSS)
#define TCP_SND_QUEUELEN                (2 * TCP_SND_BUF / TCP_MSS)
#define TCP_WND                         (4 * TCP_MSS)
#define LWIP_TCP_KEEPALIVE              1
#define LWIP_SO_RCVTIMEO                1

/* UDP configuration */
#define LWIP_UDP                        1

/* DHCP */
#define LWIP_DHCP                       1

/* ICMP (ping) */
#define LWIP_ICMP                       1

/* IPv4 only */
#define LWIP_IPV4                       1
#define LWIP_IPV6                       0

/* ARP */
#define LWIP_ARP                        1
#define ARP_TABLE_SIZE                  10

/* Netif */
#define LWIP_NETIF_STATUS_CALLBACK      1
#define LWIP_NETIF_LINK_CALLBACK        1

/* Stats (disabled for release) */
#define LWIP_STATS                      0

/* Checksum — software (HW offload not configured in ETH TX path) */
#define CHECKSUM_GEN_IP                 1
#define CHECKSUM_GEN_UDP                1
#define CHECKSUM_GEN_TCP                1
#define CHECKSUM_CHECK_IP               1
#define CHECKSUM_CHECK_UDP              1
#define CHECKSUM_CHECK_TCP              1
#define CHECKSUM_GEN_ICMP               1

/* Thread safety — allow lwIP core functions from any task */
#define LWIP_TCPIP_CORE_LOCKING         1

/* OS abstraction */
#define TCPIP_THREAD_NAME               "lwIP"
#define TCPIP_THREAD_STACKSIZE          1024
#define TCPIP_THREAD_PRIO               4
#define TCPIP_MBOX_SIZE                 16
#define DEFAULT_THREAD_STACKSIZE        512
#define DEFAULT_ACCEPTMBOX_SIZE         4
#define DEFAULT_RAW_RECVMBOX_SIZE       4
#define DEFAULT_UDP_RECVMBOX_SIZE       4
#define DEFAULT_TCP_RECVMBOX_SIZE       4

/* Use standard errno.h for error codes */
#define LWIP_ERRNO_STDINCLUDE           1

/* Debug (disabled) */
#define LWIP_DEBUG                      0

#endif /* LWIPOPTS_H */
