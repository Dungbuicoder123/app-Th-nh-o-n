# Đoàn Viên Số cho Android



## Tài khoản Firebase và dữ liệu sinh hoạt

### Đăng ký email cá nhân

1. Trong Firebase Authentication của dự án Android, bật **Email/Password** và cho phép người dùng tạo tài khoản. Android sử dụng Firestore mặc định.
2. Triển khai quy tắc trong [firestore.rules](firestore.rules) trước khi phân phối APK. Nếu dự án đang dùng các collection khác, đối chiếu với quy tắc đang chạy trước khi xuất bản. Các quy tắc mở rộng có thể cấp thêm quyền trên cùng đường dẫn. Với dự án chỉ phục vụ ứng dụng này, triển khai từ thư mục dự án bằng `firebase deploy --only firestore:rules --project doanviensoandroid`.
3. Trên điện thoại, chọn **Đăng ký bằng email cá nhân**, nhập email, mật khẩu rồi chọn **Tạo tài khoản**. Nhập họ tên và chọn một vai trò. **Bí thư** nhập tên chi đoàn mới. **Đoàn viên** chọn chi đoàn đã được Bí thư tạo trong danh sách. Nhấn **Hoàn tất đăng ký** để vào màn hình Công tác. Nếu thoát giữa chừng, đăng nhập lại bằng cùng email để hoàn tất.
4. Danh bạ dùng collection `registeredUnits`. Mỗi chi đoàn có mã riêng. Hồ sơ `users/{uid}` lưu họ tên, vai trò, mã và tên chi đoàn. Khi Bí thư hoàn tất, một giao dịch ghi cả chi đoàn và hồ sơ. Chỉ tên và mã chi đoàn xuất hiện trong danh sách chọn. Danh sách CSV được đồng bộ tại `unitWork/{unitCode}/roster`. Khi cán bộ mở ứng dụng trên máy có danh sách cũ, ứng dụng bổ sung các số điện thoại chưa có trong danh sách chung. Báo cáo cục bộ vẫn được lưu theo tài khoản trên thiết bị.
5. **Cán bộ quản lý** do quản trị viên tạo tại **Firebase Authentication → Users**. Sao chép UID rồi tạo tài liệu Firestore `users/{uid}` với các trường chuỗi `role = ward_officer`, `unitCode`, `unitName` và `displayName`. Cán bộ dùng **Đăng nhập bằng email**. Chỉ quản trị viên có quyền Firebase phù hợp mới cấp hoặc sửa vai trò cán bộ. Hồ sơ hợp lệ từ bản cũ tiếp tục dùng được.

## Quản lý chi đoàn và đăng nhập

- Mở **Cá nhân → Quản lý chi đoàn** để thêm thông tin đơn vị còn thiếu hoặc sửa tên, địa chỉ, số điện thoại. Cán bộ cấp cao có thể thêm chi đoàn trực thuộc và chọn **Quản lý chi đoàn này** để làm việc trong chi đoàn đó. Quan hệ trực thuộc được lưu bằng `registeredUnits/{id}.parentUnitCode`.
- Danh mục chi đoàn được dùng trực tiếp trong màn hình đăng ký Đoàn viên. Khi cán bộ lưu xong, người đăng ký chọn **Tải lại danh sách**.
- Mở **Cá nhân → Đổi email / mật khẩu**. Đổi email cần nhập mật khẩu hiện tại và xác minh thư gửi đến email mới. Đổi mật khẩu yêu cầu nhập lại mật khẩu mới. Tài khoản Google có thể dùng nút gửi thư đặt lại mật khẩu để thiết lập mật khẩu.

## Bản 1.2.2

- Phát hành với chức năng đăng tin văn bản. Phần tải tệp, ảnh và video lên Storage đang tạm tắt.
- Cờ `NEWS_ATTACHMENTS_ENABLED` trong `MainActivity.kt` điều khiển cả nút đính kèm và cầu nối tải tệp. Khi triển khai Storage sau này, cấu hình bucket, quyền và `firebase.json` trước khi bật cờ.
- `firebase.json` hiện chỉ triển khai Firestore. Quy tắc Firestore đã được xuất bản lên dự án `doanviensoandroid`.
- Các chức năng chi đoàn, hồ sơ, khen thưởng, đăng ký, sinh hoạt và tin văn bản dùng Firestore. Đổi email/mật khẩu dùng Firebase Authentication.

## Sinh hoạt và điểm danh

1. Chọn **Nhập CSV ĐV**, tải biểu mẫu trống, điền danh sách rồi kiểm tra bản xem trước trước khi xác nhận. Số điện thoại là khóa đối chiếu khi cập nhật. Với tài khoản Firebase, đoàn viên nhập SĐT lúc đăng ký hoặc cập nhật trong mục **Cá nhân**. Bí thư xem kết quả ở bản xem trước CSV và **Danh sách ĐV**, rồi chọn **Đối chiếu lại đăng ký** để làm mới. Số cùng chi đoàn trùng nhưng khác tên, hoặc có nhiều tài khoản dùng chung số, được đánh dấu **Cần kiểm tra**.
2. Khi tạo buổi sinh hoạt, chọn riêng ngày, giờ bắt đầu và hạn điểm danh. Hai thiết bị dùng tài khoản có cùng `users/{uid}.unitCode` để chia sẻ buổi, lượt quét, lịch bù, hoạt động tình nguyện, minh chứng và điểm qua Firestore. Bí thư và cán bộ quản lý thao tác trong phạm vi đơn vị được cấp. Đoàn viên quét QR bằng tài khoản của mình. Hết hạn, Firestore từ chối lượt quét mới. Khi mở ứng dụng, mục **Thông báo** hiển thị tổng tham dự/vắng cho quản lý và nhắc tài khoản vắng kiểm tra lịch bù. Tên tài liệu đi kèm được chia sẻ; tệp gốc và dữ liệu được tạo cục bộ ở các bản trước nằm trên máy tạo.
3. Chọn **Tổng hợp sinh hoạt** để xuất số liệu theo tháng từ thiết bị. Báo cáo nhanh cho phép bổ sung biên bản và lưu PDF.
4. Khi đăng xuất, ứng dụng đóng hồ sơ hiện tại. Đăng nhập lại bằng cùng tài khoản và đơn vị để mở dữ liệu đã lưu.

## Bảng tin, đăng ký hoạt động và hồ sơ

- Bí thư và cán bộ mở **Bảng tin → Viết tin**. Tài khoản có cùng mã đơn vị nhận bài trong Bảng tin và Thông báo. **Sao chép liên kết** tạo đường dẫn mở đúng bài trên điện thoại có cài ứng dụng. Khi bí thư hoặc cán bộ mở phiên bản mới trên máy đã đăng nội dung, ứng dụng đồng bộ bài viết và hoạt động mở đăng ký cũ của tài khoản lên đơn vị.
- Đoàn viên mở **Đăng ký**, gửi hồ sơ và nhận mã tra cứu. Cán bộ xem trong **Phê duyệt hồ sơ đăng ký**. Kết quả và lý do từ chối xuất hiện trên tài khoản người gửi.
- Trong **Cá nhân → Gửi yêu cầu sửa thông tin cá nhân**, đoàn viên sửa các trường và gửi duyệt. Bí thư hoặc cán bộ cùng đơn vị xem giá trị cũ và mới trong **Cá nhân** hoặc **Thông báo**, rồi phê duyệt hoặc từ chối. Hồ sơ đã duyệt nằm tại `users/{uid}`. Vai trò và mã phân quyền đơn vị được quản trị riêng.
- Bí thư và cán bộ mở **Cá nhân → Quản lý hồ sơ đoàn viên → Cập nhật hồ sơ** để sửa trực tiếp. Tài khoản đã đăng ký xuất hiện cả khi máy chưa nhập CSV. Thông tin dòng CSV chưa khớp được lưu trong danh sách của đơn vị. Đoàn viên có thể gửi yêu cầu cập nhật trạng thái sinh hoạt. Cán bộ xem Bí thư tại **Tổng hợp sinh hoạt**, dùng danh sách đã đối chiếu để ghi nhận khen thưởng, và đồng bộ tổng số để đoàn viên xem mà vẫn giữ riêng hồ sơ cá nhân.
- Khen thưởng mới lưu tại `unitWork/{unitCode}/awards`. Bí thư và cán bộ xem các khen thưởng của đơn vị, đoàn viên xem khen thưởng gắn với tài khoản mình.
- Firestore lưu bài viết và hoạt động tại `unitWork/{unitCode}/events`, hồ sơ đăng ký tại `applications` và yêu cầu sửa thông tin tại `profileRequests` dưới cùng đơn vị. Thông báo xuất hiện trong ứng dụng khi dữ liệu đồng bộ.

## Phát hành

Gói ứng dụng là `vn.dongnai.doanvienso`. Mở dự án bằng Android Studio và chọn Gradle JDK 17. Trên máy này, JDK nằm ở `.tools/jdk17/Contents/Home`.

Khóa phát hành PKCS12 nằm trong `.signing/doanvienso-release.p12`, alias `doanvienso`. Mật khẩu ngẫu nhiên nằm trong `.signing/release-password`. Sao lưu khóa và mật khẩu vào hai nơi an toàn riêng biệt. Thư mục này chỉ dành cho người quản lý phát hành.

Gradle ưu tiên biến môi trường `DOANVIENSO_SIGNING_PASSWORD`, sau đó đọc tệp mật khẩu cục bộ đã có. Để build lại bản ký trên máy này, chạy từ thư mục dự án:

```sh
export JAVA_HOME="$PWD/.tools/jdk17/Contents/Home"
./gradlew :app:assembleRelease :app:bundleRelease
```

Gradle ghi AAB vào `outputs/bundle/release/` và APK cài trực tiếp vào `outputs/apk/release/` bên dưới `${java.io.tmpdir}/doanvienso-android-build/app/`. Bản bàn giao 1.2.2 gồm `release/DoanVienSo-1.2.2.apk` và `release/DoanVienSo-1.2.2.aab`.
