//go:build darwin

package wailsapp

/*
#include <mach/mach.h>
#include <stdlib.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <time.h>

// CPU ticks since boot, all cores: idle and total.
static int ox_cpu(unsigned long long *idle, unsigned long long *total) {
	host_cpu_load_info_data_t info;
	mach_msg_type_number_t n = HOST_CPU_LOAD_INFO_COUNT;
	if (host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, (host_info_t)&info, &n) != KERN_SUCCESS) return 0;
	unsigned long long t = 0;
	for (int i = 0; i < CPU_STATE_MAX; i++) t += info.cpu_ticks[i];
	*idle = info.cpu_ticks[CPU_STATE_IDLE];
	*total = t;
	return 1;
}

// Memory in bytes: installed, and in use the way Activity Monitor
// counts it (app memory, wired and compressed).
static int ox_mem(unsigned long long *total, unsigned long long *used) {
	size_t len = sizeof(*total);
	if (sysctlbyname("hw.memsize", total, &len, NULL, 0) != 0) return 0;
	vm_statistics64_data_t vm;
	mach_msg_type_number_t n = HOST_VM_INFO64_COUNT;
	if (host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vm, &n) != KERN_SUCCESS) return 0;
	vm_size_t page = 0;
	host_page_size(mach_host_self(), &page);
	unsigned long long app = (unsigned long long)(vm.internal_page_count - vm.purgeable_count);
	*used = (app + vm.wire_count + vm.compressor_page_count) * (unsigned long long)page;
	return 1;
}

static long long ox_boottime(void) {
	struct timeval tv;
	size_t len = sizeof(tv);
	int mib[2] = { CTL_KERN, KERN_BOOTTIME };
	if (sysctl(mib, 2, &tv, &len, NULL, 0) != 0) return 0;
	return (long long)tv.tv_sec;
}
*/
import "C"

import "time"

func memoryMB() (total, used uint64) {
	var t, u C.ulonglong
	if C.ox_mem(&t, &u) == 0 {
		return 0, 0
	}
	return uint64(t) / (1 << 20), uint64(u) / (1 << 20)
}

func cpuTimes() (idle, total uint64, ok bool) {
	var i, t C.ulonglong
	if C.ox_cpu(&i, &t) == 0 {
		return 0, 0, false
	}
	return uint64(i), uint64(t), true
}

func uptimeSeconds() uint64 {
	boot := int64(C.ox_boottime())
	if boot <= 0 {
		return 0
	}
	return uint64(time.Now().Unix() - boot)
}

func loadAverage() []float64 {
	var avg [3]C.double
	if C.getloadavg(&avg[0], 3) != 3 {
		return nil
	}
	return []float64{float64(avg[0]), float64(avg[1]), float64(avg[2])}
}
